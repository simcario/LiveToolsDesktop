// Build environment of the "asio" Cargo feature.
//
//   npm run app:asio                     the app in dev with ASIO
//   LIVETOOLS_ASIO=1 npm run installer   an installer with ASIO, see the note in README.md
//
// Needs libclang (scoop install llvm). The Steinberg SDK can't be redistributed, so
// it stays out of the repo: it's downloaded once into %USERPROFILE%\.asio_sdk.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SDK_URL = 'https://www.steinberg.net/asiosdk';
const SCOOP = join(homedir(), 'scoop', 'apps');
const SDK_ROOT = join(homedir(), '.asio_sdk');

const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const posix = (p) => p.replaceAll('\\', '/');

function ensureSdk() {
  const sdk = join(SDK_ROOT, 'ASIOSDK');
  if (existsSync(join(sdk, 'common', 'asio.h'))) return sdk;
  console.log(`\n▸ Download dell'ASIO SDK in ${SDK_ROOT}`);
  mkdirSync(SDK_ROOT, { recursive: true });
  const zip = join(SDK_ROOT, 'asiosdk.zip');
  const script = `Invoke-WebRequest -UseBasicParsing -Uri '${SDK_URL}' -OutFile '${zip}'; Expand-Archive -Path '${zip}' -DestinationPath '${SDK_ROOT}' -Force`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(join(sdk, 'common', 'asio.h'))) fail(`Download dell'ASIO SDK non riuscito: mettilo a mano in ${sdk}`);
  return sdk;
}

/** Variables to add to the environment of a build with the "asio" feature. */
export function asioEnv(toolchain) {
  const llvm = process.env.LIBCLANG_PATH ? dirname(process.env.LIBCLANG_PATH) : join(SCOOP, 'llvm', 'current');
  const bin = join(llvm, 'bin');
  if (!existsSync(join(bin, 'libclang.dll'))) fail(`libclang non trovato in ${bin}: installalo con "scoop install llvm" o imposta LIBCLANG_PATH`);
  const env = { CPAL_ASIO_DIR: ensureSdk(), LIBCLANG_PATH: bin };
  if (toolchain.includes('gnu')) {
    // libclang defaults to the MSVC target and doesn't find its own headers.
    const clang = join(llvm, 'lib', 'clang');
    const builtin = join(clang, readdirSync(clang)[0], 'include');
    const mingw = join(SCOOP, 'mingw', 'current', 'x86_64-w64-mingw32', 'include');
    env.BINDGEN_EXTRA_CLANG_ARGS = `--target=x86_64-pc-windows-gnu -isystem${posix(builtin)} -I${posix(mingw)}`;
  }
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const toolchain = process.env.LIVETOOLS_TOOLCHAIN || 'stable-x86_64-pc-windows-gnu';
  const env = { ...process.env, ...asioEnv(toolchain), RUSTUP_TOOLCHAIN: toolchain };
  const mingwBin = join(SCOOP, 'mingw', 'current', 'bin');
  if (toolchain.includes('gnu') && existsSync(mingwBin)) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `${mingwBin};${env[key]}`;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync('npx tauri dev --features asio', { cwd: root, env, stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}
