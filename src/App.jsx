import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getRole, isSeparator } from './shared/setlists.js';
import { auth } from './lib/firebase';
import { useAccess, useAuthUser, useSetlist, useSetlists } from './lib/data';
import { engine, useEngineStatus } from './lib/engine';
import { buildLanes } from './lib/lanes';
import { clearHistory } from './lib/arrangeHistory';
import { discardDraft, isDirty, saveDraft, useDraftItems } from './lib/drafts';
import { checkCache } from './lib/mediaCache';
import { useSettings } from './lib/settings';
import { hideSplash } from './lib/splash';
import { usePlayer } from './lib/usePlayer';
import { usePrompterBroadcast, usePrompterOutput } from './lib/prompter';
import { checkForUpdates, useUpdater } from './lib/updater';
import ArrangementView from './components/ArrangementView';
import Browser from './components/Browser';
import Icon from './components/Icon';
import DetailView from './components/DetailView';
import Login from './components/Login';
import SessionView from './components/SessionView';
import PrompterView from './components/PrompterView';
import ScoreView from './components/ScoreView';
import SetlistEditor from './components/SetlistEditor';
import SongsPage from './components/SongsPage';
import SettingsModal from './components/SettingsModal';
import PreferencesPanel from './components/PreferencesPanel';
import HelpPanel from './components/HelpPanel';
import Transport from './components/Transport';

const VIEWS = ['session', 'arrangement', 'prompter', 'score'];
// Pages (tabs at the bottom, as the pages of a video editor): playing and editing the setlist.
const PAGES = [
  ['live', 'Live', 'play'],
  ['setlist', 'Scaletta', 'edit'],
  ['songs', 'Brani', 'music'],
];

async function openOutput(label, title) {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  // eslint-disable-next-line no-new
  new WebviewWindow(label, { url: `index.html?view=${label}`, title: `LiveTools · ${title}`, width: 960, height: 540 });
}
const openVideoOutput = () => openOutput('video', 'Uscita video');
const openPrompterOutput = () => openOutput('prompter', 'Gobbo');

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

function StatusBar({ message, device, page, onPage, onUpdates }) {
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
      ) : (
        <span>
          <span className="kbd">Spazio</span> play/stop · <span className="kbd">←</span>
          <span className="kbd">→</span> brano · <span className="kbd">Tab</span> vista · <span className="kbd">Invio</span> avvia selezionato
        </span>
      )}
    </footer>
  );
}

// Edits of the song left in the Arrangement not saved yet: save, drop or keep
// them for later (the song stays marked with a dot in the list).
function UnsavedModal({ item, onSave, onDiscard, onLater }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onLater()}>
      <div className="modal modal-sm" role="dialog" aria-modal="true" aria-label="Modifiche non salvate">
        <div className="modal-head">
          <h2>Modifiche non salvate</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onLater} aria-label="Chiudi" disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="small muted">
            “<strong>{item.title}</strong>” ha modifiche dell’Arrangement non salvate (tracce, tempo, metro, cue, griglia). Finché non le salvi le
            senti solo su questo computer.
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDiscard} disabled={busy}>
            Non salvare
          </button>
          <button type="button" className="btn btn-sm" onClick={onLater} disabled={busy}>
            Più tardi
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
            {busy ? 'Salvataggio…' : 'Salva'}
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

  const notify = useCallback((text, error = false) => setMessage(text ? { text, error } : null), []);
  const email = (user.email || '').toLowerCase();
  const role = getRole(setlist, user.uid, email, isAdmin);
  const canDrive = ['owner', 'admin', 'editor', 'stage'].includes(role);

  const player = usePlayer({ user, setlist, items, settings, canDrive, notify });
  const songs = player.songs;
  const numbers = useMemo(() => Object.fromEntries(songs.map((s, i) => [s.id, i + 1])), [songs]);
  const lanes = useMemo(() => buildLanes(songs), [songs]);
  const selected = items.find((i) => i.id === selectedId && !isSeparator(i)) || player.loadedItem || songs[0] || null;
  const canEdit = ['owner', 'admin', 'editor'].includes(role);
  const page = ['setlist', 'songs'].includes(settings.page) ? settings.page : 'live';
  const openInPrompter = useCallback(
    (itemId) => {
      setSelectedId(itemId);
      update({ page: 'live', view: 'prompter' });
    },
    [update],
  );
  // Another song in the player while the one before has unsaved edits: ask to save them.
  const [askSave, setAskSave] = useState(null); // itemId
  const lastLoaded = useRef(null);
  const loadedId = player.loaded?.itemId ?? null;
  useEffect(() => {
    const prev = lastLoaded.current;
    lastLoaded.current = loadedId;
    if (prev && prev !== loadedId && isDirty(prev)) setAskSave(prev);
  }, [loadedId]);
  const askItem = askSave && items.find((i) => i.id === askSave);

  usePrompterOutput(player.loadedItem, settings);
  usePrompterBroadcast({ setlist, loadedItem: player.loadedItem, settings, enabled: settings.driveStage && canDrive, user, notify });

  // Audio interface (re)opened when the choice changes.
  useEffect(() => {
    let cancelled = false;
    engine
      .openDevice(settings.audioDevice, settings.bufferSize)
      .then((info) => !cancelled && setDevice({ info }))
      .catch((e) => !cancelled && setDevice({ error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [settings.audioDevice, settings.bufferSize]);

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
      if (settingsOpen || prefsOpen || helpOpen) return;
      if ((e.ctrlKey || e.metaKey) && PAGES[Number(e.key) - 1]) {
        e.preventDefault();
        update({ page: PAGES[Number(e.key) - 1][0] });
        return;
      }
      if (e.target.closest?.('input, select, textarea')) return;
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
          update({ click: { ...settings.click, enabled: !settings.click.enabled } });
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, songs, selected, settings.view, settings.click, settingsOpen, prefsOpen, helpOpen, update, page]);

  return (
    <div className="app">
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
        showViews={page === 'live'}
        onSettings={() => setSettingsOpen(true)}
        onPrefs={() => setPrefsOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onSignOut={() => {
          if (confirm(`Uscire da ${user.email}?`)) {
            engine.unload();
            signOut(auth);
          }
        }}
      />
      <Browser
        setlists={setlists}
        setlistId={setlistId}
        onSetlist={(id) => update({ setlistId: id })}
        items={items}
        numbers={numbers}
        selectedId={selected?.id}
        loadedId={player.loaded?.itemId}
        liveItemId={setlist?.live?.itemId}
        onSelect={setSelectedId}
        onLoad={(it) => player.load(it)}
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
        ) : settings.view === 'session' ? (
          <SessionView
            items={items}
            numbers={numbers}
            lanes={lanes}
            player={player}
            selectedId={selected?.id}
            liveItemId={setlist?.live?.itemId}
            onSelect={setSelectedId}
            settings={settings}
            update={update}
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
      {page === 'live' && (
        <DetailView item={selected} number={selected ? numbers[selected.id] : null} lanes={lanes} player={player} onVideoOutput={openVideoOutput} />
      )}
      <StatusBar message={message} device={device} page={page} onPage={(p) => update({ page: p })} onUpdates={() => setPrefsOpen('updates')} />
      {prefsOpen && (
        <PreferencesPanel
          settings={settings}
          update={update}
          initialSection={typeof prefsOpen === 'string' ? prefsOpen : undefined}
          onClose={() => setPrefsOpen(false)}
        />
      )}
      {settingsOpen && <SettingsModal settings={settings} update={update} device={device} onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
      {askItem && isDirty(askItem.id) && (
        <UnsavedModal
          item={askItem}
          onSave={() =>
            saveDraft(setlistId, askItem)
              .then(() => notify(`Salvato “${askItem.title}”`))
              .catch((e) => notify(`“${askItem.title}” non salvato: ${e.message || e}`, true))
              .finally(() => setAskSave(null))
          }
          onDiscard={() => {
            discardDraft(askItem.id);
            clearHistory(askItem.id);
            setAskSave(null);
          }}
          onLater={() => setAskSave(null)}
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
  return <Workspace user={user} />;
}
