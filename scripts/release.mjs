// Builds the Windows installer and publishes it as an app update.
//
//   npm run installer                    installer of the current version (release/v<x.y.z>/)
//   npm run release -- patch|minor|major|<x.y.z> [--notes "..." | --notes-file f.md]
//                                        bump the version, build, publish the update
//   npm run release:publish [-- --notes "..."]
//                                        publish the installer already built for the current version
//   --draft (with release or publish)    leave it a draft on GitHub: the apps don't see it until it is
//                                        published by hand (or by running release:publish without --draft)
//
// Every installer has ASIO: the Steinberg SDK is used under GPLv3, like the app (LICENSE, README.md).
// Building it needs libclang (scripts/asio.mjs).
//
// Updates are GitHub Releases of a public repo (only installers there, the source code, GPLv3,
// is in simcario/LiveToolsDesktop): the app reads releases/latest/download/latest.json, see
// plugins.updater in tauri.conf.json.
//
// Outside the repo, in %USERPROFILE%\.tauri:
//   livetools.key       updater signing key (lose it and installed apps can't update anymore)
//   github-token        GitHub token with "Contents: read & write" on the releases repo
//                       (or the GITHUB_TOKEN env variable; to create the repo, a classic token with "repo")
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asioEnv } from './asio.mjs';

const RELEASES_REPO = 'simcario/LiveTools-releases';
// The source code of every published installer (GPLv3 §6): linked from the release notes.
const SOURCE_REPO = 'simcario/LiveToolsDesktop';
const PRODUCT = 'LiveTools';
// The Visual Studio install on the dev PC can't link MSVC binaries: build with the GNU toolchain.
const TOOLCHAIN = process.env.LIVETOOLS_TOOLCHAIN || 'stable-x86_64-pc-windows-gnu';
const MINGW_BIN = join(homedir(), 'scoop', 'apps', 'mingw', 'current', 'bin');
// Prerequisites in the installer (src-tauri/windows/hooks.nsh), downloaded into windows/redist/
// (not in the repo). The NDI runtime is Vizrt's redistributable: the NDI outputs need it.
const REDIST = [
  { file: 'vc_redist.x64.exe', name: 'Microsoft Visual C++ Redistributable (x64)', urls: ['https://aka.ms/vs/17/release/vc_redist.x64.exe'] },
  {
    file: 'NDI 6 Runtime.exe',
    name: 'NDI 6 Runtime',
    urls: ['https://ndi.link/NDIRedistV6', 'https://downloads.ndi.tv/SDK/NDI_SDK/NDI%206%20Runtime.exe'],
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');
const keyDir = join(homedir(), '.tauri');
const paths = {
  pkg: join(root, 'package.json'),
  conf: join(tauriDir, 'tauri.conf.json'),
  cargo: join(tauriDir, 'Cargo.toml'),
  redist: join(tauriDir, 'windows', 'redist'),
  key: process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(keyDir, 'livetools.key'),
  token: join(keyDir, 'github-token'),
};

const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

// ---------- Arguments ----------

const [command, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const DRAFT = rest.includes('--draft');
const bumpArg = rest.find((a, i) => !a.startsWith('--') && !(rest[i - 1]?.startsWith('--') && rest[i - 1] !== '--draft'));

// ---------- Version ----------

const currentVersion = () => readJson(paths.conf).version;

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [ma, mi, pa] = current.split('.').map(Number);
  if (bump === 'major') return `${ma + 1}.0.0`;
  if (bump === 'minor') return `${ma}.${mi + 1}.0`;
  if (bump === 'patch') return `${ma}.${mi}.${pa + 1}`;
  fail(`Versione non valida: "${bump}" (usa patch, minor, major o x.y.z)`);
}

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function setVersion(version) {
  const pkg = readJson(paths.pkg);
  pkg.version = version;
  writeJson(paths.pkg, pkg);
  const conf = readJson(paths.conf);
  conf.version = version;
  writeJson(paths.conf, conf);
  // Only the [package] version, the first one in the file.
  const cargo = readFileSync(paths.cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`);
  writeFileSync(paths.cargo, cargo);
}

// ---------- Build ----------

async function fetchRedist() {
  for (const { file, name, urls } of REDIST) {
    const dest = join(paths.redist, file);
    if (existsSync(dest) && statSync(dest).size > 1e6) continue;
    step(`Download di ${name}`);
    let error = '';
    for (const url of urls) {
      const res = await fetch(url).catch((e) => ({ ok: false, status: e.message }));
      if (!res.ok) {
        error += `\n  ${url}: HTTP ${res.status}`;
        continue;
      }
      mkdirSync(paths.redist, { recursive: true });
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      break;
    }
    if (!existsSync(dest)) fail(`Download di ${name} non riuscito:${error}\n  Mettilo a mano in ${dest}`);
  }
}

function build(version) {
  if (!existsSync(paths.key)) fail(`Chiave di firma degli aggiornamenti mancante: ${paths.key}\n  Creala con: npx tauri signer generate -w "${paths.key}"`);
  step(`Build di ${PRODUCT} ${version} (${TOOLCHAIN})`);
  const env = {
    ...process.env,
    RUSTUP_TOOLCHAIN: TOOLCHAIN,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(paths.key, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  };
  if (TOOLCHAIN.includes('gnu') && existsSync(MINGW_BIN)) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `${MINGW_BIN};${env[key]}`;
  }
  Object.assign(env, asioEnv(TOOLCHAIN));
  const r = spawnSync('npx tauri build --features asio', { cwd: root, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('Build non riuscita');
  return collect(version);
}

/** Copies installer and signature into release/v<version>/ next to the update manifest. */
function collect(version, notes) {
  const nsis = join(tauriDir, 'target', 'release', 'bundle', 'nsis');
  const setup = join(nsis, `${PRODUCT}_${version}_x64-setup.exe`);
  const out = join(root, 'release', `v${version}`);
  const files = { setup: join(out, basename(setup)), sig: join(out, `${basename(setup)}.sig`), manifest: join(out, 'latest.json') };
  // The bundle folder has the latest build; without it, the copy already in release/v<version>/.
  const fresh = existsSync(setup) && existsSync(`${setup}.sig`);
  if (!fresh && !(existsSync(files.setup) && existsSync(files.sig))) fail(`Installer della ${version} non trovato in ${nsis}: lancia prima "npm run installer"`);
  mkdirSync(out, { recursive: true });
  if (fresh) {
    copyFileSync(setup, files.setup);
    copyFileSync(`${setup}.sig`, files.sig);
  }
  writeJson(files.manifest, {
    version,
    notes: notes ?? (existsSync(files.manifest) ? readJson(files.manifest).notes : `${PRODUCT} ${version}`),
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: readFileSync(files.sig, 'utf8').trim(),
        url: `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${basename(setup)}`,
      },
    },
  });
  console.log(`\n✔ Installer: ${files.setup} (${(statSync(files.setup).size / 1024 ** 2).toFixed(1)} MB)`);
  return files;
}

// ---------- Publish (GitHub Releases) ----------

function token() {
  const t = process.env.GITHUB_TOKEN || (existsSync(paths.token) && readFileSync(paths.token, 'utf8').trim());
  if (!t) fail(`Token GitHub mancante: salvalo in ${paths.token} o nella variabile GITHUB_TOKEN`);
  return t;
}

async function gh(method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(`GitHub ${method} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

async function uploadAssets(repo, release, files) {
  for (const file of files) {
    const name = basename(file);
    const old = release.assets.find((a) => a.name === name);
    if (old) await gh('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
    const data = readFileSync(file);
    process.stdout.write(`  ↑ ${name} (${(data.length / 1024 ** 2).toFixed(1)} MB)… `);
    const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    await gh('POST', url, data, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) });
    console.log('ok');
  }
}

async function ensureRepo() {
  if (await gh('GET', `/repos/${RELEASES_REPO}`)) return;
  step(`Creazione del repo pubblico ${RELEASES_REPO}`);
  const [owner, name] = RELEASES_REPO.split('/');
  const me = await gh('GET', '/user');
  const body = { name, private: false, auto_init: true, description: `${PRODUCT} Desktop: installer e aggiornamenti` };
  await gh('POST', me.login === owner ? '/user/repos' : `/orgs/${owner}/repos`, body);
}

/** Release notes plus what the GPL and the ASIO guidelines ask to state next to the download. */
const releaseBody = (version, notes) =>
  `${notes}\n\n---\nLiveTools è software libero sotto licenza GPL-3.0-or-later. Codice sorgente di questa versione: ` +
  `https://github.com/${SOURCE_REPO}/tree/v${version}\n\n` +
  'Supporta i driver ASIO®. ASIO is a registered trademark of Steinberg Media Technologies GmbH.';

async function publish(version, files) {
  const manifest = readJson(files.manifest);
  await ensureRepo();
  const latest = await gh('GET', `/repos/${RELEASES_REPO}/releases/latest`);
  if (latest && !newer(version, latest.tag_name.replace(/^v/, '')) && latest.tag_name !== `v${version}`)
    fail(`Su GitHub c’è già la ${latest.tag_name}, più recente della ${version}: aumenta la versione`);

  step(`Pubblicazione della v${version} su ${RELEASES_REPO}`);
  // Draft until every file is up: the apps must never see a latest.json without its installer.
  let release = (await gh('GET', `/repos/${RELEASES_REPO}/releases?per_page=30`)).find((r) => r.tag_name === `v${version}`);
  if (release) release = await gh('PATCH', `/repos/${RELEASES_REPO}/releases/${release.id}`, { draft: true, body: releaseBody(version, manifest.notes) });
  else
    release = await gh('POST', `/repos/${RELEASES_REPO}/releases`, {
      tag_name: `v${version}`,
      name: `${PRODUCT} ${version}`,
      body: releaseBody(version, manifest.notes),
      draft: true,
    });

  await uploadAssets(RELEASES_REPO, release, [files.setup, files.sig, files.manifest]);
  if (DRAFT) {
    console.log(`
✔ v${version} caricata in bozza: ${release.html_url}`);
    console.log('  Le app installate non la vedono finché non la pubblichi (GitHub › Publish release, o npm run release:publish).');
    return;
  }
  await gh('PATCH', `/repos/${RELEASES_REPO}/releases/${release.id}`, { draft: false, make_latest: 'true' });
  console.log(`\n✔ Aggiornamento ${version} pubblicato: https://github.com/${RELEASES_REPO}/releases/tag/v${version}`);
  console.log('  Le app installate lo vedranno al prossimo avvio (o da Impostazioni › Aggiornamenti).');
}

// ---------- Main ----------

const notes = opt('notes-file') ? readFileSync(opt('notes-file'), 'utf8').trim() : opt('notes');

if (command === 'installer') {
  await fetchRedist();
  const version = currentVersion();
  build(version);
  if (notes) collect(version, notes);
} else if (command === 'release') {
  if (!bumpArg) fail('Indica la versione: npm run release -- patch|minor|major|x.y.z');
  const version = nextVersion(currentVersion(), bumpArg);
  setVersion(version);
  console.log(`Versione: ${version}`);
  await fetchRedist();
  build(version);
  const files = collect(version, notes);
  await publish(version, files);
  console.log(`\n  Ricordati di fare commit del cambio di versione: git commit -am "v${version}" && git tag v${version} && git push --follow-tags`);
  console.log(`  Il link al codice sorgente nelle note punta al tag v${version} di ${SOURCE_REPO}: va pubblicato.`);
} else if (command === 'publish') {
  const version = currentVersion();
  await publish(version, collect(version, notes));
} else {
  fail('Comando sconosciuto: usa installer, release o publish');
}
