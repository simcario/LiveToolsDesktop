// Build environment of the "asio" Cargo feature.
//
//   npm run app:asio                     the app in dev with ASIO (npm run app stays WASAPI only)
//   npm run installer / release          always build with ASIO, see scripts/release.mjs
//
// Needs libclang (scoop install llvm). The Steinberg ASIO SDK is used under its GPLv3 option, like
// the whole app (LICENSE): the parts that get compiled are in src-tauri/vendor/asiosdk. Never build
// the feature without CPAL_ASIO_DIR, or asio-sys downloads the SDK and renames the first asio* folder
// it finds in %TEMP%.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOOP = join(homedir(), 'scoop', 'apps');
const SDK = join(root, 'src-tauri', 'vendor', 'asiosdk');

const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const posix = (p) => p.replaceAll('\\', '/');

/** Variables to add to the environment of a build with the "asio" feature. */
export function asioEnv(toolchain) {
  if (!existsSync(join(SDK, 'common', 'asio.h'))) fail(`ASIO SDK mancante in ${SDK}`);
  const llvm = process.env.LIBCLANG_PATH ? dirname(process.env.LIBCLANG_PATH) : join(SCOOP, 'llvm', 'current');
  const bin = join(llvm, 'bin');
  if (!existsSync(join(bin, 'libclang.dll'))) fail(`libclang non trovato in ${bin}: installalo con "scoop install llvm" o imposta LIBCLANG_PATH`);
  const env = { CPAL_ASIO_DIR: SDK, LIBCLANG_PATH: bin };
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
  const r = spawnSync('npx tauri dev --features asio', { cwd: root, env, stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}
