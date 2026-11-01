/* STUDIO / RÉGIE MUSICALE V2 — prototype autonome, sans dépendance externe.
   Les fichiers audio sont conservés uniquement sur cet ordinateur via IndexedDB. */
(() => {
  "use strict";

  const STATE_KEY = "studio-regie-v2-state";
  const DB_NAME = "studio-regie-v2-audio";
  const DB_STORE = "files";
  const BANK_PAGES = 4;
  const BANK_SLOTS_PER_PAGE = 40;
  const $ = (id) => document.getElementById(id);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
  const uid = () => `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  const durationText = (seconds) => {
    const s = Math.max(0, Math.floor(Number.isFinite(Number(seconds)) ? Number(seconds) : 0));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const newState = () => ({
    version: 2,
    media: [],
    playlists: [{ id: "playlist-principale", name: "PROGRAMME PRINCIPAL", items: [] }],
    activePlaylistId: "playlist-principale",
    schedules: [],
    bankPage: 0,
    bankAssignments: {},
    defaultFade: 2,
    masterVolume: 90,
    autoNext: true
  });

  let state = newState();
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (saved && typeof saved === "object") state = { ...newState(), ...saved };
  } catch (e) { console.warn("Configuration locale illisible", e); }
  if (!Array.isArray(state.media)) state.media = [];
  if (!Array.isArray(state.playlists) || !state.playlists.length) state.playlists = newState().playlists;
  if (!Array.isArray(state.schedules)) state.schedules = [];
  if (!state.bankAssignments || typeof state.bankAssignments !== "object") state.bankAssignments = {};
  if (!state.playlists.some((p) => p.id === state.activePlaylistId)) state.activePlaylistId = state.playlists[0].id;
  state.bankPage = clamp(state.bankPage, 0, BANK_PAGES - 1);
  state.masterVolume = clamp(state.masterVolume, 0, 100);
  state.defaultFade = clamp(state.defaultFade, 0, 15);

  let db = null;
  let player = null;
  let previousDeck = null;
  let fadeTimer = null;
  let launchToken = 0;
  let starting = false;
  let automaticChange = false;
  let bankSounds = new Map();
  let bankEditMode = false;
  let bankClearMode = false;
  let editingBankSlot = null;
  let lastScheduleCheck = Date.now();
  let screen = "onair";

  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
    catch (e) { message(`Sauvegarde impossible : ${e.message}`, true); }
  }
  function message(text, error = false) {
    const node = $("message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
  function currentPlaylist() {
    return state.playlists.find((p) => p.id === state.activePlaylistId) || state.playlists[0];
  }
  function mediaById(id) { return state.media.find((m) => m.id === id); }
  function mediaOptions(includeEmpty = false) {
    return (includeEmpty ? '<option value="">— AUCUN MÉDIA —</option>' : "") +
      state.media.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
  }
  function bankKey(slot) { return String(state.bankPage * BANK_SLOTS_PER_PAGE + slot); }
  function assignment(id) { return state.bankAssignments[id] || null; }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB non pris en charge"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Échec ouverture base locale"));
    });
  }
  function putMedia(id, file) {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error("Stockage local indisponible"));
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(file, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Échec enregistrement média"));
    });
  }
  function getMedia(id) {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error("Stockage local indisponible"));
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Échec chargement média"));
    });
  }
  function deleteMediaBlob(id) {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error("Stockage local indisponible"));
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Échec suppression média"));
    });
  }
  function readDuration(file) {
    return new Promise((resolve) => {
      let settled = false;
      const objectUrl = URL.createObjectURL(file);
      const audio = new Audio();
      const finish = (d) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(objectUrl);
        resolve(Number.isFinite(d) ? d : 0);
      };
      const timeout = setTimeout(() => finish(0), 4500);
      audio.onloadedmetadata = () => finish(audio.duration);
      audio.onerror = () => finish(0);
      audio.preload = "metadata";
      audio.src = objectUrl;
    });
  }

  async function importAudio(files) {
    if (!db) return message("Le stockage local de ce navigateur est inaccessible.", true);
    let imported = 0, errors = 0, relinked = 0;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name)) continue;
      const existing = state.media.find((m) => m.fileName === file.name && (m.size === file.size || !m.size));
      const id = existing ? existing.id : uid();
      try {
        await putMedia(id, file);
        if (existing) {
          relinked++;
          if (!existing.duration) existing.duration = await readDuration(file);
        } else {
          const duration = await readDuration(file);
          state.media.push({ id, name: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, duration, size: file.size });
          imported++;
        }
      } catch (e) {
        console.warn("Import audio impossible", e);
        errors++;
      }
    }
    save();
    render();
    message(`${imported} nouveau(x) média(s), ${relinked} lien(s) rétabli(s)${errors ? `, ${errors} erreur(s) de stockage` : ""}.`, errors > 0);
  }

  function releaseDeck(deck) {
    if (!deck) return;
    try { deck.audio.pause(); deck.audio.onended = null; deck.audio.onerror = null; deck.audio.removeAttribute("src"); deck.audio.load(); }
    catch (e) { console.warn(e); }
    URL.revokeObjectURL(deck.url);
  }
  function cancelFade() {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
    if (previousDeck) { releaseDeck(previousDeck); previousDeck = null; }
  }
  function stopMain(silent = false) {
    launchToken++;
    starting = false;
    automaticChange = false;
    cancelFade();
    releaseDeck(player);
    player = null;
    renderQueue();
    refreshPlayer();
    if (!silent) message("Lecture principale arrêtée.");
  }
  function stopBanks(silent = false) {
    for (const sound of bankSounds.values()) releaseDeck(sound);
    bankSounds.clear();
    renderBanks();
    if (!silent) message("Toutes les banques sonores sont arrêtées.");
  }
  function stopAll() { stopMain(true); stopBanks(true); message("STOP GÉNÉRAL — Tous les sons sont arrêtés."); }
  function setVolume() {
    $("volume").value = state.masterVolume;
    $("volume-text").textContent = `${state.masterVolume}%`;
    if (player && !fadeTimer) player.audio.volume = state.masterVolume / 100;
    for (const bank of bankSounds.values()) bank.audio.volume = state.masterVolume / 100;
  }

  async function playIndex(index, fadeOverride = null) {
    const list = currentPlaylist();
    const item = list.items[index];
    if (!item) { message("Aucun titre à cette position du conducteur.", true); return false; }
    const media = mediaById(item.mediaId);
    if (!media) { message("Ce média a été supprimé de la médiathèque.", true); return false; }
    if (starting) return false;
    starting = true;
    const token = ++launchToken;
    let url = null;
    let audio = null;
    try {
      const blob = await getMedia(media.id);
      if (token !== launchToken) return false;
      if (!blob) throw new Error(`« ${media.name} » est absent de cet ordinateur. Importe à nouveau le fichier audio.`);
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.preload = "auto";
      const requestedFade = fadeOverride === null ? Number(item.fade ?? state.defaultFade) : Number(fadeOverride);
      const fade = player && !player.audio.paused ? clamp(requestedFade, 0, 15) : 0;
      audio.volume = fade > 0 ? 0 : state.masterVolume / 100;
      await audio.play();
      if (token !== launchToken) { audio.pause(); URL.revokeObjectURL(url); return false; }
      cancelFade();
      const oldDeck = player;
      const newDeck = { audio, url, mediaId: media.id, index, playlistId: list.id, autoTriggered: false };
      player = newDeck;
      audio.onended = () => {
        if (player !== newDeck) return;
        if (state.autoNext && index + 1 < currentPlaylist().items.length) {
          void playIndex(index + 1, 0);
        } else {
          stopMain(true);
          message("Fin de la playlist.");
        }
      };
      audio.onerror = () => message("Erreur pendant la lecture de ce média.", true);
      if (oldDeck && fade > 0) {
        previousDeck = oldDeck;
        const start = performance.now();
        fadeTimer = setInterval(() => {
          const progress = Math.min(1, (performance.now() - start) / (fade * 1000));
          oldDeck.audio.volume = (state.masterVolume / 100) * (1 - progress);
          if (player === newDeck) audio.volume = (state.masterVolume / 100) * progress;
          if (progress >= 1) { cancelFade(); if (player === newDeck) audio.volume = state.masterVolume / 100; }
        }, 40);
      } else releaseDeck(oldDeck);
      renderQueue();
      refreshPlayer();
      message(`EN LECTURE : ${media.name}`);
      return true;
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      if (audio) { audio.pause(); audio.removeAttribute("src"); }
      message(`Lecture impossible : ${e.message}`, true);
      return false;
    } finally {
      if (token === launchToken) starting = false;
    }
  }
  function togglePlay() {
    if (player) {
      if (player.audio.paused) player.audio.play().catch((e) => message(`Lecture refusée : ${e.message}`, true));
      else player.audio.pause();
      refreshPlayer();
    } else void playIndex(0, 0);
  }
  function nextTrack() {
    const next = player ? player.index + 1 : 0;
    if (next >= currentPlaylist().items.length) {
      stopMain(true);
      message("Fin du conducteur.");
      return;
    }
    void playIndex(next, state.defaultFade);
  }
  function refreshPlayer() {
    const media = player ? mediaById(player.mediaId) : null;
    const audio = player?.audio;
    const elapsed = audio?.currentTime || 0;
    const duration = audio && Number.isFinite(audio.duration) ? audio.duration : media?.duration || 0;
    const playing = !!audio && !audio.paused;
    $("now-playing").textContent = media ? media.name : "AUCUN TITRE EN COURS";
    $("now-detail").textContent = media ? playing ? "EN DIFFUSION • CONDUCTEUR AUTOMATIQUE" : "EN PAUSE" : "Sélectionne une playlist et lance la lecture";
    $("time-remaining").textContent = durationText(Math.max(0, duration - elapsed));
    $("time-elapsed").textContent = `ÉCOULÉ : ${durationText(elapsed)}`;
    $("progress-fill").style.width = duration > 0 ? `${Math.min(100, elapsed / duration * 100)}%` : "0%";
    $("onair-indicator").textContent = playing ? "ON AIR" : "HORS ANTENNE";
    $("onair-indicator").classList.toggle("live", playing);
    $("onair-large").textContent = playing ? "ON AIR" : "STANDBY";
    $("onair-large").parentElement.classList.toggle("live", playing);
    $("play-main").textContent = audio?.paused ? "▶ REPRENDRE" : "▶ LECTURE";
  }

  function switchPlaylist(id) {
    if (!state.playlists.some((p) => p.id === id)) return;
    if (state.activePlaylistId !== id) stopMain(true);
    state.activePlaylistId = id;
    save();
    render();
  }
  function playlistOptions() {
    return state.playlists.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  }
  function renderSelectors() {
    for (const id of ["onair-playlist", "edit-playlist"]) {
      $(id).innerHTML = playlistOptions();
      $(id).value = state.activePlaylistId;
    }
    $("media-to-add").innerHTML = mediaOptions();
    $("bank-assign").innerHTML = mediaOptions(true);
  }
  function renderQueue() {
    const playlist = currentPlaylist();
    const isActive = player && player.playlistId === playlist.id;
    const active = isActive ? player.index : -1;
    $("onair-queue").innerHTML = playlist.items.length ? playlist.items.map((item, i) => {
      const media = mediaById(item.mediaId);
      const position = String(i + 1).padStart(2, "0");
      const type = i === active ? "current" : i === active + 1 ? "next" : "";
      return `<div class="queue-row ${type}"><div class="number">${position}</div><div><div class="name">${escapeHtml(media?.name || "MÉDIA MANQUANT")}</div><div class="meta">${i === active ? "● EN COURS" : i === active + 1 ? "► PROCHAIN" : "EN ATTENTE"} · Fondu ${clamp(item.fade, 0, 15).toFixed(1)}s</div></div><div class="duration">${durationText(media?.duration)}</div><button class="mini-play" data-queue-play="${i}" title="Lire ce titre">▶</button></div>`;
    }).join("") : `<div class="empty">Aucun élément dans ce conducteur.<br>Ajoute tes morceaux dans PLAYLISTS.</div>`;
  }
  function renderEditList() {
    const playlist = currentPlaylist();
    $("edit-items").innerHTML = playlist.items.length ? playlist.items.map((item, i) => {
      const media = mediaById(item.mediaId);
      return `<div class="edit-row"><strong>${String(i + 1).padStart(2, "0")}</strong><div><div class="name">${escapeHtml(media?.name || "MÉDIA MANQUANT")}</div><div class="fade-control"><label for="fade-${i}">FONDU</label><input id="fade-${i}" type="number" step="0.5" min="0" max="15" value="${clamp(item.fade, 0, 15)}" data-fade="${i}" aria-label="Fondu du titre ${i + 1} en secondes"><span>SEC.</span></div></div><div class="row-buttons"><button class="square" data-move="${i}" data-direction="-1" title="Monter">↑</button><button class="square" data-move="${i}" data-direction="1" title="Descendre">↓</button><button class="square delete" data-remove="${i}" title="Retirer de la playlist">×</button></div></div>`;
    }).join("") : `<div class="empty">Playlist vide.<br>Choisis un média dans la liste au-dessus, puis + AJOUTER.</div>`;
  }
  function renderSchedules() {
    const sorted = [...state.schedules].sort((a, b) => a.at.localeCompare(b.at));
    const html = sorted.length ? sorted.map((entry) => {
      const playlist = state.playlists.find((p) => p.id === entry.playlistId);
      const timestamp = new Date(entry.at);
      const label = Number.isNaN(timestamp.getTime()) ? "Date invalide" : timestamp.toLocaleString("fr-FR");
      const status = entry.status === "done" ? "EFFECTUÉ" : entry.status === "missed" ? "MANQUÉ" : "PRÉVU";
      return `<div class="schedule-item ${entry.status === "done" ? "done" : ""}"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(playlist?.name || "Playlist supprimée")} · ${status}</small></div><button class="square delete" data-delete-schedule="${escapeHtml(entry.id)}" title="Annuler">×</button></div>`;
    }).join("") : '<div class="empty">Aucun départ programmé.</div>';
    $("schedule-list").innerHTML = html;
    $("onair-schedules").innerHTML = html;
  }
  function renderLibrary() {
    const search = $("search-media").value.trim().toLocaleLowerCase("fr-FR");
    const files = state.media.filter((m) => m.name.toLocaleLowerCase("fr-FR").includes(search));
    $("media-count").textContent = `${state.media.length} MÉDIA(S)`;
    $("media-list").innerHTML = files.length ? files.map((m) => `<div class="media-row"><div><div class="media-title">♫ ${escapeHtml(m.name)}</div><small>${durationText(m.duration)} · ${escapeHtml(m.fileName || "fichier")}</small></div><button class="action danger-outline small" data-delete-media="${escapeHtml(m.id)}">SUPPRIMER</button></div>`).join("") : `<div class="empty">${state.media.length ? "Aucun média trouvé." : "Bibliothèque vide. Importe ton premier fichier audio."}</div>`;
  }
  function renderBanks() {
    const halves = [[], []];
    for (let slot = 0; slot < BANK_SLOTS_PER_PAGE; slot++) {
      const id = bankKey(slot);
      const assigned = assignment(id);
      const media = assigned ? mediaById(assigned.mediaId) : null;
      const local = slot % 20;
      const hotkey = local < 10 ? (slot < 20 ? `F${local + 1}` : `⇧F${local + 1}`) : "";
      const active = bankSounds.has(id);
      halves[slot < 20 ? 0 : 1].push(`<button class="pad ${media ? "filled" : ""} ${active ? "active" : ""}" data-pad="${slot}" title="${escapeHtml(media?.name || "Case vide — activer EDIT pour affecter")}"><span class="pad-no">CASE ${String(slot + 1).padStart(2, "0")}</span><span class="pad-shortcut">${hotkey}</span><span class="pad-name">${escapeHtml(assigned?.label || media?.name || "LIBRE")}</span></button>`);
    }
    $("pads-left").innerHTML = halves[0].join("");
    $("pads-right").innerHTML = halves[1].join("");
    $("bank-page").textContent = `BANQUE ${String(state.bankPage + 1).padStart(2, "0")} / ${String(BANK_PAGES).padStart(2, "0")}`;
    $("bank-mode").textContent = bankEditMode ? "MODE ÉDITION" : bankClearMode ? "MODE EFFACEMENT" : "MODE DIFFUSION";
    $("bank-edit").classList.toggle("selected", bankEditMode);
    $("bank-clear").classList.toggle("selected", bankClearMode);
  }
  function bankDisplay(title, detail) {
    $("banks-display").innerHTML = `<small>STUDIO / SOUND BANK</small><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  }
  function render() {
    renderSelectors();
    renderQueue();
    renderEditList();
    renderSchedules();
    renderLibrary();
    renderBanks();
    $("auto-next").checked = !!state.autoNext;
    $("default-crossfade").value = state.defaultFade;
    setVolume();
    refreshPlayer();
  }

  async function triggerBank(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= BANK_SLOTS_PER_PAGE) return;
    const key = bankKey(slot);
    if (bankClearMode) {
      if (bankSounds.has(key)) { releaseDeck(bankSounds.get(key)); bankSounds.delete(key); }
      delete state.bankAssignments[key];
      bankClearMode = false;
      save(); renderBanks(); bankDisplay("CASE EFFACÉE", `Case ${slot + 1}`); return;
    }
    if (bankEditMode) {
      editingBankSlot = key;
      const a = assignment(key);
      $("bank-dialog-title").textContent = `Banque ${state.bankPage + 1} · case ${slot + 1}`;
      $("bank-assign").value = a?.mediaId || "";
      $("bank-custom-label").value = a?.label || "";
      $("bank-dialog").showModal();
      return;
    }
    if (bankSounds.has(key)) {
      releaseDeck(bankSounds.get(key));
      bankSounds.delete(key);
      renderBanks(); bankDisplay("STOP CASE", `Case ${slot + 1} arrêtée.`); return;
    }
    const a = assignment(key);
    const media = a && mediaById(a.mediaId);
    if (!media) { message("Case vide : active EDIT et clique sur la case pour lui attribuer un média."); return; }
    let url = null;
    try {
      const blob = await getMedia(media.id);
      if (!blob) throw new Error("Fichier absent sur cet ordinateur. Réimporte le média.");
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = state.masterVolume / 100;
      await audio.play();
      const sound = { audio, url, mediaId: media.id };
      bankSounds.set(key, sound);
      audio.onended = () => {
        if (bankSounds.get(key) !== sound) return;
        releaseDeck(sound); bankSounds.delete(key); renderBanks();
      };
      bankDisplay("▶ " + (a.label || media.name), `Lecture de la case ${slot + 1} · ${durationText(media.duration)}`);
      renderBanks();
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      message(`Déclenchement impossible : ${e.message}`, true);
    }
  }

  function showScreen(next) {
    if (!document.querySelector(`[data-page="${next}"]`)) return;
    screen = next;
    document.querySelectorAll("[data-page]").forEach((section) => { section.hidden = section.dataset.page !== next; });
    document.querySelectorAll("[data-screen]").forEach((tab) => tab.classList.toggle("current", tab.dataset.screen === next));
  }

  function newPlaylist() {
    const name = window.prompt("Nom de la nouvelle playlist :", "NOUVELLE PLAYLIST");
    if (!name || !name.trim()) return;
    const id = uid();
    state.playlists.push({ id, name: name.trim().slice(0, 80), items: [] });
    switchPlaylist(id);
    message(`Playlist « ${name.trim()} » créée.`);
  }
  function removePlaylist() {
    if (state.playlists.length === 1) { message("Il faut conserver au moins une playlist.", true); return; }
    if (!window.confirm("Supprimer cette playlist et ses départs programmés ?")) return;
    const id = state.activePlaylistId;
    stopMain(true);
    state.playlists = state.playlists.filter((p) => p.id !== id);
    state.schedules = state.schedules.filter((s) => s.playlistId !== id);
    state.activePlaylistId = state.playlists[0].id;
    save(); render(); message("Playlist supprimée.");
  }
  function removeTrack(index) {
    if (index < 0 || index >= currentPlaylist().items.length) return;
    stopMain(true);
    currentPlaylist().items.splice(index, 1);
    save(); render();
  }
  function moveTrack(index, diff) {
    const list = currentPlaylist().items;
    const to = index + diff;
    if (to < 0 || to >= list.length) return;
    stopMain(true);
    [list[index], list[to]] = [list[to], list[index]];
    save(); render();
  }
  async function removeMedia(id) {
    if (!mediaById(id)) return;
    if (!window.confirm("Supprimer ce fichier du navigateur, de toutes les playlists et des banques ?")) return;
    stopAll();
    try { await deleteMediaBlob(id); }
    catch (e) { return message(`Suppression locale impossible : ${e.message}`, true); }
    state.media = state.media.filter((m) => m.id !== id);
    for (const p of state.playlists) p.items = p.items.filter((x) => x.mediaId !== id);
    for (const key of Object.keys(state.bankAssignments)) {
      if (state.bankAssignments[key].mediaId === id) delete state.bankAssignments[key];
    }
    save(); render(); message("Média supprimé.");
  }
  function addSchedule() {
    const at = $("schedule-date").value;
    const time = new Date(at).getTime();
    if (!at || !Number.isFinite(time) || time <= Date.now()) { message("Choisis une date et une heure futures.", true); return; }
    if (!currentPlaylist().items.length) { message("Ajoute d'abord un titre à la playlist.", true); return; }
    state.schedules.push({ id: uid(), at, playlistId: state.activePlaylistId, status: "pending" });
    save(); renderSchedules(); message("Départ programmé (l'onglet doit rester actif et le navigateur autoriser l'audio).");
  }
  function tickSchedules(now) {
    const delta = now - lastScheduleCheck;
    if (delta < 200 || delta > 1000 * 60 * 60 * 12) { lastScheduleCheck = now; return; }
    for (const entry of state.schedules) {
      if (entry.status !== "pending") continue;
      const planned = new Date(entry.at).getTime();
      if (Number.isNaN(planned) || planned > now) continue;
      // Ne jamais démarrer un conducteur des heures en retard après veille ou fermeture d'onglet.
      if (now - planned > 15000) {
        entry.status = "missed";
        message(`Départ de ${new Date(planned).toLocaleTimeString("fr-FR")} manqué (retard supérieur à 15 s).`, true);
      } else if (planned >= lastScheduleCheck - 1000) {
        const playlist = state.playlists.find((p) => p.id === entry.playlistId);
        if (playlist) {
          entry.status = "done";
          stopMain(true);
          state.activePlaylistId = playlist.id;
          renderSelectors(); renderQueue(); renderEditList();
          void playIndex(0, 0).then((ok) => { if (!ok) message("Départ programmé non lancé : le navigateur a refusé ou le fichier est absent.", true); });
        } else entry.status = "missed";
      }
      save(); renderSchedules();
    }
    lastScheduleCheck = now;
  }
  function tick() {
    const now = new Date();
    $("digital-clock").textContent = now.toLocaleTimeString("fr-FR", { hour12: false });
    $("date-display").textContent = now.toLocaleDateString("fr-FR");
    if (player && state.autoNext && !player.audio.paused && !player.autoTriggered && !starting && !automaticChange) {
      const list = currentPlaylist();
      const next = list.items[player.index + 1];
      const duration = player.audio.duration;
      const remaining = duration - player.audio.currentTime;
      const fade = next ? clamp(next.fade ?? state.defaultFade, 0, 15) : 0;
      if (next && fade > 0 && Number.isFinite(duration) && remaining <= fade && remaining > 0) {
        player.autoTriggered = true;
        automaticChange = true;
        void playIndex(player.index + 1, Math.min(fade, remaining)).finally(() => { automaticChange = false; });
      }
    }
    refreshPlayer();
    tickSchedules(now.getTime());
  }

  function exportSettings() {
    const data = { ...state, exportedAt: new Date().toISOString(), note: "AUDIO NON INCLUS — réimporte les fichiers audio sur le nouvel ordinateur." };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `studio-regie-v2-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    message("Conducteur exporté en JSON (sans les fichiers audio).");
  }
  async function importSettings(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.media) || !Array.isArray(parsed.playlists) || !parsed.playlists.length || typeof parsed.bankAssignments !== "object") {
        throw new Error("Format incompatible. Import attendu : fichier JSON STUDIO V2.");
      }
      if (!window.confirm("Remplacer toutes les playlists, banques et programmations par ce fichier ? Les médias audio locaux ne seront pas effacés.")) return;
      stopAll();
      const oldMedia = state.media;
      const manifest = parsed.media.map((m) => ({ id: String(m.id || uid()), name: String(m.name || "Média").slice(0, 255), fileName: String(m.fileName || ""), size: Number(m.size) || 0, duration: Number(m.duration) || 0 }));
      // Conserve les médias locaux supplémentaires, qui pourront être utilisés par de nouvelles playlists.
      for (const old of oldMedia) {
        if (!manifest.some((m) => m.id === old.id || (m.fileName && m.fileName === old.fileName && m.size === old.size))) manifest.push(old);
      }
      const lists = parsed.playlists.map((p) => ({ id: String(p.id || uid()), name: String(p.name || "Playlist").slice(0, 80), items: Array.isArray(p.items) ? p.items.filter((x) => x && x.mediaId).map((x) => ({ mediaId: String(x.mediaId), fade: clamp(x.fade, 0, 15) })) : [] }));
      const banks = {};
      for (const [k, v] of Object.entries(parsed.bankAssignments || {})) {
        if (/^\d+$/.test(k) && Number(k) < BANK_PAGES * BANK_SLOTS_PER_PAGE && v?.mediaId) banks[k] = { mediaId: String(v.mediaId), label: String(v.label || "").slice(0, 32) };
      }
      state = { ...newState(), media: manifest, playlists: lists, activePlaylistId: lists.some((p) => p.id === parsed.activePlaylistId) ? parsed.activePlaylistId : lists[0].id, schedules: Array.isArray(parsed.schedules) ? parsed.schedules.filter((s) => s && s.id && s.at && s.playlistId) : [], bankAssignments: banks, bankPage: clamp(parsed.bankPage, 0, BANK_PAGES - 1), defaultFade: clamp(parsed.defaultFade, 0, 15), masterVolume: clamp(parsed.masterVolume, 0, 100), autoNext: !!parsed.autoNext };
      save(); render(); message("Conducteur importé. Réimporte les fichiers audio manquants pour rétablir leurs liens.");
    } catch (e) { message(`Import impossible : ${e.message}`, true); }
  }

  function setupEvents() {
    document.querySelectorAll("[data-screen]").forEach((tab) => tab.addEventListener("click", () => showScreen(tab.dataset.screen)));
    $("fullscreen-btn").addEventListener("click", async () => {
      try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }
      catch (e) { message(`Plein écran impossible : ${e.message}`, true); }
    });
    $("onair-playlist").addEventListener("change", (e) => switchPlaylist(e.target.value));
    $("edit-playlist").addEventListener("change", (e) => switchPlaylist(e.target.value));
    $("play-main").addEventListener("click", togglePlay);
    $("pause-main").addEventListener("click", () => { if (player) { player.audio.pause(); refreshPlayer(); } });
    $("next-main").addEventListener("click", nextTrack);
    $("stop-main").addEventListener("click", () => stopMain());
    $("auto-next").addEventListener("change", (e) => { state.autoNext = e.target.checked; save(); });
    $("volume").addEventListener("input", (e) => { state.masterVolume = clamp(e.target.value, 0, 100); setVolume(); save(); });
    $("onair-queue").addEventListener("click", (e) => { const button = e.target.closest("[data-queue-play]"); if (button) void playIndex(Number(button.dataset.queuePlay), state.defaultFade); });
    $("new-playlist").addEventListener("click", newPlaylist);
    $("delete-playlist").addEventListener("click", removePlaylist);
    $("add-to-playlist").addEventListener("click", () => {
      const mediaId = $("media-to-add").value;
      if (!mediaById(mediaId)) return message("Importe d'abord des fichiers dans MÉDIATHÈQUE.", true);
      currentPlaylist().items.push({ mediaId, fade: state.defaultFade });
      save(); renderQueue(); renderEditList(); message("Média ajouté au conducteur.");
    });
    $("edit-items").addEventListener("change", (e) => {
      const n = e.target.dataset.fade;
      if (n === undefined) return;
      const item = currentPlaylist().items[Number(n)];
      if (!item) return;
      item.fade = clamp(e.target.value, 0, 15);
      save(); renderQueue();
      // Ne pas reconstruire le champ actuellement édité pendant son événement change/blur.
      e.target.value = item.fade;
    });
    $("edit-items").addEventListener("click", (e) => {
      const remove = e.target.closest("[data-remove]");
      if (remove) return removeTrack(Number(remove.dataset.remove));
      const move = e.target.closest("[data-move]");
      if (move) moveTrack(Number(move.dataset.move), Number(move.dataset.direction));
    });
    $("add-schedule").addEventListener("click", addSchedule);
    for (const id of ["schedule-list", "onair-schedules"]) $(id).addEventListener("click", (e) => {
      const button = e.target.closest("[data-delete-schedule]");
      if (!button) return;
      state.schedules = state.schedules.filter((s) => s.id !== button.dataset.deleteSchedule);
      save(); renderSchedules();
    });
    $("audio-upload").addEventListener("change", async (e) => { await importAudio(e.target.files); e.target.value = ""; });
    $("search-media").addEventListener("input", renderLibrary);
    $("media-list").addEventListener("click", (e) => { const button = e.target.closest("[data-delete-media]"); if (button) void removeMedia(button.dataset.deleteMedia); });
    $("delete-all").addEventListener("click", async () => {
      if (!state.media.length || !window.confirm("Supprimer tous les fichiers audio de ce navigateur ET vider playlists et banques ?")) return;
      stopAll();
      for (const item of state.media) { try { await deleteMediaBlob(item.id); } catch (e) { console.warn("Échec suppression", e); } }
      state.media = [];
      for (const p of state.playlists) p.items = [];
      state.bankAssignments = {};
      state.schedules = [];
      save(); render(); message("Tous les médias locaux ont été supprimés.");
    });
    for (const id of ["pads-left", "pads-right"]) $(id).addEventListener("click", (e) => { const pad = e.target.closest("[data-pad]"); if (pad) void triggerBank(Number(pad.dataset.pad)); });
    $("bank-prev").addEventListener("click", () => { state.bankPage = (state.bankPage + BANK_PAGES - 1) % BANK_PAGES; save(); renderBanks(); });
    $("bank-next").addEventListener("click", () => { state.bankPage = (state.bankPage + 1) % BANK_PAGES; save(); renderBanks(); });
    $("bank-first").addEventListener("click", () => { state.bankPage = 0; save(); renderBanks(); });
    $("bank-edit").addEventListener("click", () => { bankEditMode = !bankEditMode; bankClearMode = false; renderBanks(); bankDisplay(bankEditMode ? "MODE ÉDITION" : "MODE DIFFUSION", bankEditMode ? "Clique sur une case pour lui affecter un média." : "Clique sur une case pour déclencher son son."); });
    $("bank-clear").addEventListener("click", () => { bankClearMode = !bankClearMode; bankEditMode = false; renderBanks(); bankDisplay("MODE EFFACEMENT", "Clique sur une case pour supprimer son affectation."); });
    $("bank-update").addEventListener("click", () => { renderBanks(); message("Banques actualisées."); });
    $("bank-stop").addEventListener("click", () => stopBanks());
    $("bank-stop-all").addEventListener("click", stopAll);
    $("bank-search").addEventListener("click", () => { showScreen("library"); $("search-media").focus(); });
    $("bank-config").addEventListener("click", () => showScreen("settings"));
    $("bank-cancel").addEventListener("click", () => $("bank-dialog").close());
    $("bank-save").addEventListener("click", () => {
      if (editingBankSlot === null) return;
      const mediaId = $("bank-assign").value;
      if (mediaId && mediaById(mediaId)) state.bankAssignments[editingBankSlot] = { mediaId, label: $("bank-custom-label").value.trim().slice(0, 32) };
      else delete state.bankAssignments[editingBankSlot];
      save(); renderBanks(); $("bank-dialog").close(); message("Affectation enregistrée.");
    });
    $("bank-remove").addEventListener("click", () => { if (editingBankSlot !== null) delete state.bankAssignments[editingBankSlot]; save(); renderBanks(); $("bank-dialog").close(); });
    $("default-crossfade").addEventListener("change", (e) => { state.defaultFade = clamp(e.target.value, 0, 15); save(); e.target.value = state.defaultFade; });
    $("export-settings").addEventListener("click", exportSettings);
    $("import-settings").addEventListener("change", async (e) => { if (e.target.files[0]) await importSettings(e.target.files[0]); e.target.value = ""; });
    document.addEventListener("keydown", (e) => {
      if ($("bank-dialog").open || e.target.matches("input,textarea,select") || e.target.isContentEditable) return;
      const key = e.key.toLowerCase();
      const fn = /^f([1-9]|10)$/i.exec(e.key);
      if (fn && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        void triggerBank((e.shiftKey ? 20 : 0) + Number(fn[1]) - 1);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (key === "b" && !e.shiftKey) { e.preventDefault(); showScreen("banks"); return; }
        const digit = /^[0-9]$/.test(key) ? (key === "0" ? 9 : Number(key) - 1) : -1;
        if (digit >= 0) { e.preventDefault(); void triggerBank((e.shiftKey ? 20 : 0) + digit); return; }
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (key === "n") { e.preventDefault(); nextTrack(); }
      else if (key === "s") { e.preventDefault(); stopAll(); }
    });
    window.addEventListener("beforeunload", () => { if (player) player.audio.pause(); for (const sound of bankSounds.values()) sound.audio.pause(); });
  }

  async function boot() {
    setupEvents();
    try {
      db = await openDatabase();
      message("Régie prête. Importe tes médias depuis MÉDIATHÈQUE, puis programme tes playlists.");
    } catch (e) {
      message(`Le stockage des médias est indisponible dans ce navigateur : ${e.message}`, true);
    }
    render();
    tick();
    setInterval(tick, 250);
  }
  void boot();
})();
