/**
 * electron-builder configuration for the HA Tax Preparer installer.
 *
 * Code signing comes from the build machine's environment, so no certificate
 * or password is ever committed. One of:
 *  - A certificate file (.pfx): WIN_CSC_LINK (path, https URL or base64) and
 *    WIN_CSC_KEY_PASSWORD. electron-builder reads these itself.
 *  - A certificate in the Windows certificate store or on a USB token:
 *    HATAX_SIGN_CERT_SHA1 (its thumbprint) or HATAX_SIGN_CERT_SUBJECT.
 *    OV and EV certificates issued since June 2023 come on a token or a cloud
 *    key store, not as a .pfx file.
 *  - Azure Trusted Signing: HATAX_AZURE_SIGN_ENDPOINT, HATAX_AZURE_SIGN_ACCOUNT,
 *    HATAX_AZURE_SIGN_PROFILE and HATAX_SIGN_PUBLISHER, with AZURE_TENANT_ID,
 *    AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for its service principal.
 * HATAX_REQUIRE_SIGNING=1 fails the build when nothing signs it, so an
 * unsigned installer is never released by mistake.
 *
 * Signed: the program, the installer and uninstaller, llama-server and every
 * DLL and native module the app ships. Microsoft's own DLLs keep their
 * Microsoft signature.
 */

const { readdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const env = process.env;
const LLAMA_BIN = join(__dirname, '..', 'tools', 'llama-cpp', 'bin');

/** Signed by Microsoft in Electron's distribution; re-signing would replace that. */
const MICROSOFT_SIGNED = new Set(['d3dcompiler_47.dll', 'dxil.dll']);

const dllsIn = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dll'));
  } catch {
    return [];
  }
};

// electron-builder matches these by file-name ending.
const signExts = [
  '.node',
  ...dllsIn(LLAMA_BIN),
  ...dllsIn(dirname(require('electron'))).filter((f) => !MICROSOFT_SIGNED.has(f.toLowerCase())),
];

const azure = env.HATAX_AZURE_SIGN_ENDPOINT
  ? {
      azureSignOptions: {
        endpoint: env.HATAX_AZURE_SIGN_ENDPOINT,
        codeSigningAccountName: env.HATAX_AZURE_SIGN_ACCOUNT,
        certificateProfileName: env.HATAX_AZURE_SIGN_PROFILE,
        publisherName: env.HATAX_SIGN_PUBLISHER,
      },
    }
  : null;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.hatax.preparer',
  productName: 'HA Tax Preparer',
  directories: { output: 'release', buildResources: 'build' },
  files: [
    'dist/**',
    'package.json',
    // bcrypt ships prebuilt binaries for every platform; only Windows ones can load here.
    '!**/node_modules/bcrypt/prebuilds/{darwin,linux}-*/**',
  ],
  asar: true,
  npmRebuild: false,
  forceCodeSigning: env.HATAX_REQUIRE_SIGNING === '1',
  extraResources: [
    { from: '../client/dist', to: 'client' },
    { from: '../tools/llama-cpp/bin', to: 'llama-cpp', filter: ['llama-server.exe', '*.dll', 'LICENSE*'] },
    {
      from: '../models/unsloth/Qwen3.5-0.8B-GGUF',
      to: 'models/unsloth/Qwen3.5-0.8B-GGUF',
      filter: ['Qwen3.5-0.8B-Q4_K_M.gguf', 'mmproj-F16.gguf'],
    },
    { from: '../models/mradermacher/GLM-OCR-GGUF', to: 'models/mradermacher/GLM-OCR-GGUF', filter: ['GLM-OCR.Q4_K_M.gguf'] },
    { from: '../models/ggml-org/GLM-OCR-GGUF', to: 'models/ggml-org/GLM-OCR-GGUF', filter: ['mmproj-GLM-OCR-Q8_0.gguf'] },
  ],
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    artifactName: 'HA-Tax-Preparer-Setup-${version}.${ext}',
    signExts,
    ...(azure ?? {
      signtoolOptions: {
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
        ...(env.HATAX_SIGN_CERT_SHA1 ? { certificateSha1: env.HATAX_SIGN_CERT_SHA1 } : {}),
        ...(env.HATAX_SIGN_CERT_SUBJECT ? { certificateSubjectName: env.HATAX_SIGN_CERT_SUBJECT } : {}),
      },
    }),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'HA Tax Preparer',
  },
};
