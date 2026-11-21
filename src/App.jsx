import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { signOut } from 'firebase/auth';
import { getRole, isSeparator } from './shared/setlists.js';
import { auth } from './lib/firebase';
import { useAccess, useAuthUser, useSetlist, useSetlists } from './lib/data';
import { engine, onDeviceChange, setAudioWatch, useEngineStatus } from './lib/engine';
import { buildLanes } from './lib/lanes';
import { clearHistory } from './lib/arrangeHistory';
import { discardDraft, isDirty, onSaveFailed, saveDraft, savedMessage, useDraftItems } from './lib/drafts';
import { checkCache } from './lib/mediaCache';
import { toggleZone, useSettings } from './lib/settings';
import { hideSplash } from './lib/splash';
import { usePlayer } from './lib/usePlayer';
import { usePrompterBroadcast, usePrompterOutput } from './lib/prompter';
import { ndiLatency, useNdiOutputs, useNdiPrompter } from './lib/ndi';
import { checkForUpdates, useUpdater } from './lib/updater';
import ArrangementView from './components/ArrangementView';
import Browser from './components/Browser';
import Icon from './components/Icon';
import DetailView from './components/DetailView';
import LoadingModal from './components/LoadingModal';
import Login from './components/Login';
import FreeDeviceGate from './components/FreeDeviceGate';
import StageView from './components/StageView';
import PrompterView from './components/PrompterView';
import ScoreView from './components/ScoreView';
import SetlistEditor from './components/SetlistEditor';
import SongsPage from './components/SongsPage';
import SettingsModal from './components/SettingsModal';
import PreferencesPanel from './components/PreferencesPanel';
import PreflightModal from './components/PreflightModal';
import MidiLearnBar from './components/MidiLearnBar';
import { useMidiControl } from './lib/midiLearn';
import { lanLiveOf, useStageNet, useStageNetState } from './lib/stageNet';
import { useBackup } from './lib/backup';
import { bandOf, useBandLeaveNotice, useOnlineMembers, usePingResponder, usePresence } from './lib/presence';
import HelpPanel from './components/HelpPanel';
import Transport from './components/Transport';
import { ZoneResizer, zoneFrame } from './components/Zones';
import { toggleMixerWindow, useMixer, useMixerBridge } from './lib/useMixer';
import { toggleOutput, togglePrompterOutput, toggleVideoOutput, useOutputOpen } from './lib/outputs';
import { useRemoteHost } from './lib/remoteHost';

const VIEWS = ['stage', 'arrangement', 'prompter', 'score'];
const ZONE_KEYS = { KeyL: 'left', KeyE: 'lower', KeyR: 'right' };
// Pages (tabs at the bottom, as the pages of a video editor): playing and editing the setlist.
const PAGES = [
  ['live', 'Live', 'play'],
  ['setlist', 'Scaletta', 'edit'],
  ['songs', 'Brani', 'music'],
];

// Video and gobbo windows: the buttons and F4 / F6 open and close them (lib/outputs.js).
const openVideoOutput = toggleVideoOutput;
const openPrompterOutput = togglePrompterOutput;

function UpdateChip({ onOpen }) {
  const status = useUpdater((u) => u.status);
  const version = useUpdater((u) => u.version);
  if (!['available', 'downloading', 'installing'].includes(status)) return null;
  return (
    <button className="update-chip" onClick={onOpen} title="Apri Impostazioni › Aggiornamenti">
      <Icon name="download" size={11} />
      {status === 'available' ? `Aggiornamento ${version} disponibile` : `Aggiornamento ${version}…`}
    </button>
  );
}

function StatusBar({ message, device, page, stage, onPage, onUpdates }) {
  const underruns = useEngineStatus((s) => s.underruns);
  const deviceError = useEngineStatus((s) => s.deviceError);
  return (
    <footer className="statusbar">
      <nav className="pages" role="tablist" aria-label="Pagina">
        {PAGES.map(([k, label, icon], i) => (
          <button key={k} role="tab" aria-selected={page === k} className={page === k ? 'is-on' : ''} onClick={() => onPage(k)} title={`${label} (Ctrl+${i + 1})`}>
            <Icon name={icon} size={12} /> {label}
          </button>
        ))}
      </nav>
      <span className={`msg ${message?.error || deviceError ? 'err' : ''}`}>
        {deviceError ? `Scheda audio: ${deviceError}` : message?.text || 'Pronto'}
      </span>
      <UpdateChip onOpen={onUpdates} />
      {underruns > 0 && <span title="Il disco non ha fornito l’audio in tempo">Dropout: {underruns}</span>}
      {device?.info && (
        <span className="mono">
          {device.info.sampleRate} Hz · {device.info.channels} out
        </span>
      )}
      {page === 'songs' ? (
        <span>
          <span className="kbd">Ctrl+S</span> salva il brano · tracce e video valgono per tutte le scalette
        </span>
      ) : page === 'setlist' ? (
        <span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span> selezione · <span className="kbd">Ctrl+S</span> salva il brano · <span className="kbd">Spazio</span> play/stop
        </span>
      ) : stage ? (
        <span>
          <span className="kbd">Spazio</span> play/stop · <span className="kbd">1</span>–<span className="kbd">9</span> sezione · <span className="kbd">L</span> loop · <span className="kbd">Esc</span> annulla il salto · <span className="kbd">Tab</span> vista
        </span>
      ) : (
        <span>
          <span className="kbd">Spazio</span> play/stop · <span className="kbd">←</span>
          <span className="kbd">→</span> brano · <span className="kbd">Tab</span> vista · <span className="kbd">Invio</span> avvia selezionato
        </span>
      )}
    </footer>
  );
}

// Edits of the Arrangement not saved yet, asked only when the setlist is
// closed (another one chosen) or the program is closed: never on a song switch,
// the songs just stay marked with a dot in the list until saved.
function UnsavedModal({ items, reason, onSave, onDiscard, onCancel }) {
  const [busy, setBusy] = useState(false);
  const many = items.length > 1;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal modal-sm" role="dialog" aria-modal="true" aria-label="Modifiche non salvate">
        <div className="modal-head">
          <h2>Modifiche non salvate</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onCancel} aria-label="Annulla" disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="small muted">
            {many ? 'Questi brani hanno' : 'Questo brano ha'} modifiche dell’Arrangement non salvate (tracce, tempo, metro, cue, griglia, mixer).{' '}
            {reason === 'quit' ? 'Salvale prima di chiudere il programma.' : 'Salvale prima di cambiare scaletta.'}
          </p>
          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {items.map((it) => (
              <li key={it.id}>
                <strong>{it.title}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDiscard} disabled={busy}>
            {reason === 'quit' ? 'Chiudi senza salvare' : 'Non salvare'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
            Annulla
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            autoFocus
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onSave();
            }}
          >
            {busy ? 'Salvataggio…' : many ? 'Salva tutto' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Workspace({ user }) {
  const [settings, update] = useSettings();
  const setlists = useSetlists(user);
  const setlistId =
    setlists?.find((s) => s.id === settings.setlistId)?.id ?? (setlists?.length ? setlists[0].id : null);
  const { isAdmin } = useAccess(user);
  const { setlist, items: savedItems, itemDocs } = useSetlist(setlistId, user, isAdmin);
  // Shown and played with the edits not saved yet (lib/drafts.js).
  const items = useDraftItems(savedItems);
  const [selectedId, setSelectedId] = useState(null);
  const [message, setMessage] = useState(null);
  const [device, setDevice] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);

  const notify = useCallback((text, error = false) => setMessage(text ? { text, error } : null), []);
  // A save made offline and refused by the server once back online: its draft is back.
  useEffect(() => onSaveFailed(({ title, error }) => notify(`“${title}” non salvato dal server: ${error?.message || error}. Le modifiche sono tornate nella bozza`, true)), [notify]);
  // A MIDI controller on the controls of the app (MIDI learn, Ctrl+M).
  useMidiControl({ settings, update, notify });
  const email = (user.email || '').toLowerCase();
  const role = getRole(setlist, user.uid, email, isAdmin);
  const canDrive = ['owner', 'admin', 'editor', 'stage'].includes(role);
  const canEdit = ['owner', 'admin', 'editor'].includes(role);

  // Rete locale di palco: the song of the band's leader arrives here also without internet.
  const lanLive = lanLiveOf(useStageNetState(), setlist?.id);
  const player = usePlayer({ user, setlist, items, settings, canDrive, canEdit, notify, lanLive });
  // The Gobbo of the song in the player: output window, NDI, and the Leggio of the band's phones and tablets.
  const prompterSource = usePrompterOutput(player.loadedItem, settings);
  const stageNet = useStageNet({ setlist, user, settings, canDrive, loadedItem: player.loadedItem, prompter: prompterSource, notify });
  // Palco Sync: this computer among the band connected to the setlist, and who is there.
  usePresence(setlistId, user, settings.stageNet.part);
  usePingResponder(setlistId, user.uid, setlist?.live?.ping);
  const members = useOnlineMembers(setlistId);
  const band = useMemo(() => bandOf(members, stageNet, user), [members, stageNet, user]);
  useBandLeaveNotice(band, settings.followStage || settings.driveStage, notify);
  // Computer di riserva: plays along with who leads, and takes over when it is gone.
  useBackup({ settings, update, net: stageNet, player, items, canDrive, notify });
  // Unsaved Arrangement edits are asked for only when the setlist is closed
  // (another one chosen, here or from the Telecomando) or the program is closed.
  const [askSave, setAskSave] = useState(null); // { reason: 'setlist' | 'quit', then }
  const dirtyItems = items.filter((i) => isDirty(i.id));
  const guard = useRef(null);
  guard.current = { dirtyItems, setlistId };
  const chooseSetlist = useCallback(
    (id) => {
      const g = guard.current;
      if (!id || id === g.setlistId) return;
      if (g.dirtyItems.length) setAskSave({ reason: 'setlist', then: () => update({ setlistId: id }) });
      else update({ setlistId: id });
    },
    [update],
  );
  // Closing the main window: Tauri closes it after this handler unless it is prevented.
  useEffect(() => {
    let off = null;
    let gone = false;
    const win = getCurrentWindow();
    win
      .onCloseRequested((e) => {
        if (!guard.current.dirtyItems.length) return;
        e.preventDefault();
        setAskSave({ reason: 'quit', then: () => win.destroy().catch(() => {}) });
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  const askItems = askSave ? dirtyItems : [];
  // Telecomando: a phone or tablet on the same Wi-Fi drives this computer (Impostazioni › Rete locale).
  const videoOpen = useOutputOpen('video');
  const prompterOpen = useOutputOpen('prompter');
  const songs = player.songs;
  const numbers = useMemo(() => Object.fromEntries(songs.map((s, i) => [s.id, i + 1])), [songs]);
  const lanes = useMemo(() => buildLanes(songs), [songs]);
  const selected = items.find((i) => i.id === selectedId && !isSeparator(i)) || player.loadedItem || songs[0] || null;
  const page = ['setlist', 'songs'].includes(settings.page) ? settings.page : 'live';
  // Palco takes the whole window: the setlist is inside it, no Browser and no Dettaglio.
  const stage = page === 'live' && settings.view === 'stage' && !!setlistId;
  const openInPrompter = useCallback(
    (itemId) => {
      setSelectedId(itemId);
      update({ page: 'live', view: 'prompter' });
    },
    [update],
  );
  // Mixer of the song in the player: Dettaglio → Mixer and its window (F3).
  const mixer = useMixer({ player, lanes, canEdit, setlistId, notify });
  useMixerBridge(mixer);
  useRemoteHost({ settings, update, chooseSetlist, mixer, setlist, setlists, items, player, prompter: prompterSource, outputs: { video: videoOpen, prompter: prompterOpen }, toggleOutput, notify, user });

  useNdiOutputs(settings);
  useNdiPrompter(prompterSource, settings.ndi.prompter.enabled, ndiLatency(settings, 'prompter'));
  usePrompterBroadcast({ setlist, loadedItem: player.loadedItem, settings, enabled: settings.driveStage && canDrive, user, notify });

  // Audio interface (re)opened when the choice changes.
  const engineOnDefault = useRef(false);
  useEffect(() => {
    // The engine is already on the default output (the interface was pulled out).
    if (engineOnDefault.current) {
      engineOnDefault.current = false;
      return;
    }
    let cancelled = false;
    engine
      .openDevice(settings.audioDevice, settings.bufferSize)
      .then((info) => !cancelled && setDevice({ info }))
      .catch((e) => !cancelled && setDevice({ error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [settings.audioDevice, settings.bufferSize]);

  // Interfaces plugged in and out while the program runs (audio/watch.rs). A new
  // one opens the audio settings with a notice; when the one in use goes, the
  // engine has already moved to the default output: the choice follows it.
  const [plugged, setPlugged] = useState(null); // names of the outputs just plugged in
  const audioDevice = useRef(settings.audioDevice);
  audioDevice.current = settings.audioDevice;
  // Interfaces plugged in and out: detected only while the setting is on.
  useEffect(() => {
    setAudioWatch(settings.audioWatch);
  }, [settings.audioWatch]);
  useEffect(
    () =>
      onDeviceChange((c) => {
        if (c.device || c.error) setDevice(c.device ? { info: c.device } : { error: c.error });
        if (c.lost) {
          const gone = c.removed[0] || c.lost;
          notify(c.device ? `“${gone}” scollegata: l’audio passa a “${c.device.name}”` : `“${gone}” scollegata e nessuna altra uscita audio disponibile`, true);
          if (audioDevice.current) {
            engineOnDefault.current = true;
            update({ audioDevice: null });
          }
        }
        if (c.added.length) {
          setPlugged(c.added);
          setSettingsOpen(true);
        }
      }),
    [notify, update],
  );
  // "Usa questa scheda": already the choice when it was missing at startup (the default played): open it now.
  const chooseDevice = useCallback(
    (name) => {
      if (audioDevice.current !== name) return update({ audioDevice: name });
      engine
        .openDevice(name, settings.bufferSize)
        .then((info) => setDevice({ info }))
        .catch((e) => setDevice({ error: String(e) }));
    },
    [update, settings.bufferSize],
  );

  useEffect(() => {
    checkCache(items).catch(() => {});
  }, [items]);

  // New release: only looked for (a few seconds after startup), installing is up to the user.
  useEffect(() => {
    if (import.meta.env.DEV || !settings.updateCheck) return;
    const t = setTimeout(() => checkForUpdates({ silent: true }), 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard (and Bluetooth pedalboards sending arrows / page keys).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setPrefsOpen(true);
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      // Mixer in its own window, as Cubase's MixConsole.
      if (e.key === 'F3') {
        e.preventDefault();
        toggleMixerWindow();
        return;
      }
      // Output windows on / off, without reaching the projector with the mouse.
      if (e.key === 'F4' || e.key === 'F6') {
        e.preventDefault();
        if (e.key === 'F4') toggleVideoOutput();
        else togglePrompterOutput();
        return;
      }
      // Controllo pre-concerto.
      if (e.key === 'F7') {
        e.preventDefault();
        setPreflightOpen((o) => !o);
        return;
      }
      if (settingsOpen || prefsOpen || helpOpen || preflightOpen) return;
      if ((e.ctrlKey || e.metaKey) && PAGES[Number(e.key) - 1]) {
        e.preventDefault();
        update({ page: PAGES[Number(e.key) - 1][0] });
        return;
      }
      if (e.target.closest?.('input, select, textarea')) return;
      // Zones. Not while typing: Ctrl+Alt is also AltGr (AltGr+E = €).
      const zone = (e.ctrlKey || e.metaKey) && e.altKey && ZONE_KEYS[e.code];
      if (zone) {
        e.preventDefault();
        if (!stage && (zone === 'left' || (zone === 'lower') === (page === 'live'))) update((s) => toggleZone(s, zone));
        return;
      }
      // Editing page: only play/stop, the arrows move the selection in the list.
      if (page === 'songs') return;
      if (page === 'setlist' && e.key !== ' ') return;
      const idx = songs.findIndex((s) => s.id === selected?.id);
      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.toggle(selected);
          break;
        case 'Tab':
          e.preventDefault();
          update({ view: VIEWS[(VIEWS.indexOf(settings.view) + 1) % VIEWS.length] });
          break;
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          player.step(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          player.step(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (songs[idx + 1]) setSelectedId(songs[idx + 1].id);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (idx > 0) setSelectedId(songs[idx - 1].id);
          break;
        case 'Enter':
          if (selected) player.launch(selected);
          break;
        case 'Home':
          player.locate(0);
          break;
        case 'c':
        case 'C':
          if (e.shiftKey) update({ click: { ...settings.click, eighths: !settings.click.eighths } });
          else update({ click: { ...settings.click, enabled: !settings.click.enabled } });
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, songs, selected, settings.view, settings.click, settingsOpen, prefsOpen, helpOpen, preflightOpen, update, page, stage]);

  const frame = zoneFrame(settings.zones);

  return (
    <div className={`app ${frame.className} ${stage ? 'is-stage' : ''}`} style={frame.style}>
      <Transport
        user={user}
        item={player.loadedItem || selected}
        player={player}
        settings={settings}
        update={update}
        canDrive={canDrive}
        canEdit={canEdit}
        notify={notify}
        device={device}
        liveOn={!!setlist?.live?.startedAt}
        net={stageNet}
        band={setlistId ? band : null}
        setlist={setlist}
        page={page}
        showViews={page === 'live'}
        stage={stage}
        onSettings={() => setSettingsOpen(true)}
        onPrefs={() => setPrefsOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onPreflight={() => setPreflightOpen(true)}
        onSignOut={() => {
          if (confirm(`Uscire da ${user.email}?`)) {
            engine.unload();
            signOut(auth);
          }
        }}
      />
      <LoadingModal busy={player.busy} files={player.downloading} />
      <Browser
        setlists={setlists}
        setlistId={setlistId}
        onSetlist={chooseSetlist}
        items={items}
        numbers={numbers}
        selectedId={selected?.id}
        loadedId={player.loaded?.itemId}
        liveItemId={setlist?.live?.itemId}
        onSelect={setSelectedId}
        onLoad={(it) => player.load(it)}
        player={player}
        canEdit={canEdit}
        notify={notify}
        showSections={page === 'live' && settings.view === 'arrangement'}
      />
      <main className="main">
        {page === 'songs' ? (
          <SongsPage
            user={user}
            setlists={setlists}
            setlist={setlist}
            setlistItems={itemDocs}
            canEditSetlist={canEdit}
            notify={notify}
          />
        ) : !setlistId ? (
          <div className="empty">
            <div>
              <h2>Nessuna scaletta</h2>
              <p>Crea una scaletta nell’app web LiveTools o fattela condividere: comparirà qui.</p>
            </div>
          </div>
        ) : page === 'setlist' ? (
          setlist && (
            <SetlistEditor
              user={user}
              setlist={setlist}
              items={items}
              itemDocs={itemDocs}
              numbers={numbers}
              canEdit={canEdit}
              selectedId={selected?.id}
              onSelect={setSelectedId}
              onOpenPrompter={openInPrompter}
              notify={notify}
            />
          )
        ) : settings.view === 'stage' ? (
          <StageView
            items={items}
            numbers={numbers}
            lanes={lanes}
            player={player}
            selected={selected}
            liveItemId={setlist?.live?.itemId}
            onSelect={setSelectedId}
            setlists={setlists}
            setlistId={setlistId}
            onSetlist={chooseSetlist}
            settings={settings}
            update={update}
            active={!settingsOpen && !prefsOpen && !helpOpen && !preflightOpen}
            onVideoOutput={openVideoOutput}
            canEdit={canEdit}
            notify={notify}
          />
        ) : settings.view === 'score' ? (
          <ScoreView
            item={selected}
            settings={settings}
            update={update}
            active={!settingsOpen && !prefsOpen && !helpOpen}
            onPedalPrefs={() => setPrefsOpen('pedal')}
          />
        ) : settings.view === 'prompter' ? (
          <PrompterView
            item={selected}
            setlistId={setlistId}
            player={player}
            canEdit={canEdit}
            settings={settings}
            update={update}
            onOutput={openPrompterOutput}
            notify={notify}
          />
        ) : (
          <ArrangementView
            player={player}
            item={selected}
            lanes={lanes}
            settings={settings}
            update={update}
            onVideoOutput={openVideoOutput}
            canEdit={canEdit}
            setlistId={setlistId}
            notify={notify}
          />
        )}
      </main>
      {!stage && <ZoneResizer zone="left" />}
      {page === 'live' && !stage && settings.zones.lower.open && (
        <>
          <DetailView item={selected} number={selected ? numbers[selected.id] : null} lanes={lanes} player={player} mixer={mixer} onVideoOutput={openVideoOutput} />
          <ZoneResizer zone="lower" />
        </>
      )}
      <MidiLearnBar settings={settings} update={update} />
      <StatusBar message={message} device={device} page={page} stage={stage} onPage={(p) => update({ page: p })} onUpdates={() => setPrefsOpen('updates')} />
      {prefsOpen && (
        <PreferencesPanel
          settings={settings}
          update={update}
          initialSection={typeof prefsOpen === 'string' ? prefsOpen : undefined}
          items={items}
          onSendMidi={player.sendMidi}
          onClose={() => setPrefsOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          update={update}
          device={device}
          plugged={plugged}
          onUse={chooseDevice}
          onClose={() => {
            setSettingsOpen(false);
            setPlugged(null);
          }}
        />
      )}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
      {preflightOpen && (
        <PreflightModal
          items={items}
          device={device}
          settings={settings}
          net={stageNet}
          onAudio={() => {
            setPreflightOpen(false);
            setSettingsOpen(true);
          }}
          onPrefs={(section) => {
            setPreflightOpen(false);
            setPrefsOpen(section);
          }}
          onClose={() => setPreflightOpen(false)}
        />
      )}
      {askSave && (
        <UnsavedModal
          items={askItems}
          reason={askSave.reason}
          onSave={() => {
            const { then, reason } = askSave;
            const list = askItems;
            Promise.allSettled(list.map((it) => saveDraft(setlistId, it))).then((all) => {
              const failed = all.filter((r) => r.status === 'rejected');
              setAskSave(null);
              if (failed.length) return notify(`Non salvato: ${failed.map((r) => r.reason?.message || r.reason).join(', ')}`, true);
              notify(list.length === 1 ? savedMessage(list[0].title, all[0].value) : `Salvati ${list.length} brani`);
              // Closing: a moment for the writes to reach the local cache on disk.
              setTimeout(then, reason === 'quit' ? 600 : 0);
            });
          }}
          onDiscard={() => {
            const { then } = askSave;
            askItems.forEach((it) => {
              discardDraft(it.id);
              clearHistory(it.id);
            });
            setAskSave(null);
            then();
          }}
          onCancel={() => setAskSave(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  const user = useAuthUser();
  useEffect(() => {
    if (user !== undefined) hideSplash();
  }, [user]);
  if (user === undefined) return <div className="login" />;
  if (!user) return <Login />;
  return (
    <FreeDeviceGate user={user}>
      <Workspace user={user} />
    </FreeDeviceGate>
  );
}
