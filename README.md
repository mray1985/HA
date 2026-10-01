# HATax

This repository holds two separate HATax applications. Each is a complete,
self-contained copy of HATax with its own tax engine, server, client, scripts,
documentation and lockfile. Neither imports anything from the other, and a
change in one never changes the other.

| App | Folder | What it is |
|---|---|---|
| **HATax (individual)** | [`individual/`](individual/README.md) | The free, private, deterministic tax preparation app: the step-by-step interview, the HATax engine, IRS and state form generation. No AI beyond optional bring-your-own-key. |
| **HATax Preparer** | [`preparer/`](preparer/README.md) | The automated preparer product. Built from its own copy of HATax, it replaces the interview with local-AI document intake, schema-validated tax tools, two-reader verification and diagnostics, keeping only the deterministic HATax pieces (engine, form construction, storage, imports). Runs entirely on the preparer's machine. |

```
HA/
├── individual/          HATax individual app
│   ├── shared/          @hatax/engine — tax calculation engine
│   ├── server/          Express API (sign-in, optional BYOK proxy)
│   ├── client/          @hatax/individual — React app; client/public holds IRS/state PDFs, OCR data, icons
│   ├── scripts/         form-field and filing-packet tooling
│   └── docs/
└── preparer/            HATax Preparer app
    ├── shared/          its own @hatax/engine copy
    ├── local-ai/        @hatax/local-ai — TaxFacts, tax tools, document reading, verification, model gauntlet
    ├── server/          Express API (preparer sign-in), port 3002
    ├── client/          @hatax/preparer — React app
    ├── scripts/
    ├── docs/
    ├── tools/           llama.cpp CPU runtime (not committed)
    └── models/          local model weights (not committed)
```

Each app is installed, run and tested from its own folder:

```bash
cd individual   # or: cd preparer
npm install
npm run dev     # individual: client 5173, server 3001 — preparer: client 5174, server 3002
npm test
npm run build
```
