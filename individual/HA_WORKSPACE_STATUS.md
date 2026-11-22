# HA connected workspace

This change extends the existing individual return app. It is not a claim of complete TurboTax feature parity, certified filing capability, or complete federal/state form coverage.

## Run

From the individual directory, run `npm run build -w client -- --configLoader runner`, then `npm run start:workspace`. Open http://127.0.0.1:5179. The game, Taxtionary, and Radio are available through the dashboard. Open an unlocked return and choose **Three-screen workspace** to access the connected return view and HAKeeper.

## Implemented

- Three simultaneous panels: entered return information; populated official IRS PDF; written or visual explanation. Select, focus, or hover a supported calculation row to highlight its mapped PDF field. Page navigation, applicable-form selection, per-instance selection, and PDF download are implemented.
- The installed PDF set is for tax year 2025. Other years are blocked from displaying the wrong revision. The existing engine remains responsible for calculation; complete year/form coverage has not been established here.
- A five-question scored tax game with explanations, results, and replay. Seven searchable Taxtionary definitions link to IRS sources.
- Three recorded general education lessons, real audio play/pause/seek, transcripts, and local audio-file playback. HAKeeper selects its related lesson. Playback transmits no taxpayer records. Audio was generated once using a preset VoiceLabs voice and bundled with the app; runtime playback does not require a VoiceLabs account or API.
- HAKeeper manually records or CSV-imports expenses in five supported categories. It validates dates, tax year, business purpose, business, category, and cents. It rejects duplicate import rows and existing duplicates. Reviewed transfers replace prior HAKeeper-managed Schedule C expenses and preserve other entries. Income, assets, mileage, meals, and other categories remain in the existing interview.
- HAKeeper records are stored inside the existing encrypted return, using the return's encryption and lock behavior. No new plaintext ledger, analytics, broadcast of client information, or external bank connection was added.
- Calculation errors clear old results and display a message in the workspace. Data from another return is not rendered during return loading.

## Verification

- Existing engine suite: 119 files and 5,247 tests passed.
- HAKeeper tests: three tests passed, covering replacement/idempotence, preservation of manual entries, removal, invalid dates/years, invalid amounts, category, business, and purpose.
- Browser: synthetic 2025 return with $55,000 W-2 wages and $12,000 business income populated the workspace and official PDF. A reviewed $100 supplies expense changed the estimated balance due from $720.55 to $694.42. These observations verify the connection, not independent tax-law correctness.
- Browser: game scoring, definition search, reviewed Schedule C transfer, PDF rendering, and HAKeeper-linked recorded lesson playback were exercised.
- Build: TypeScript and Vite production build checked. Large pre-existing Syncfusion bundles still produce a size advisory.

## Remaining production work

Full form/year/state coverage must be inventoried and independently validated. IRS e-file/transmitter integration, production filing approval, signatures/acknowledgments/reject handling, bank account feeds, payments/refund products, cloud synchronization, and operating controls have not been completed by this change. The app is a local preparation and review build. Do not describe it as a fully working TurboTax replacement or a filing-ready production platform until those capabilities and controls are verified.

K-1 base-form extraction exists for 13 common fields. The Statements workspace now reads digital PDF text and interactive form values across a group of uploaded K-1/K-3/statement files, with optional local OCR for scanned pages. It retains each source page, text region, and cell position; correlates labelled items to issuer, recipient, year, form type, box/code, section, and explicit activity when established; and permits reviewed supported K-1 fields to replace existing values without adding repeated totals. Search and source highlighting work together. Correlation notes and application history use the existing encrypted return store. Original PDFs are held in the current tab and must be re-uploaded to view their pages in another session.

The reader does not establish complete statement coverage. QBI W-2 wages and UBIA are recognized for review but are not yet routed automatically into the per-business QBI calculation. K-3 foreign rows and country/category/column information are retained for review, not flattened into a tax credit or extra K-1 income. Complete K-3/Form 1116 calculation routing remains unfinished. Several numeric cells, conflicting values, separate activities, mismatched years/entities/recipients/form types, and unreadable pages require review. No missing amount is silently treated as zero.

Reader validation: 14 packet matching tests and the related extraction/import tests passed together (91 tests). Browser verification used three synthetic PDF files and confirmed extraction, entity/year correlation, source selection, text search, reviewed application of $2,000 ordinary income and $1,500 section 199A QBI, and retention of ambiguous K-3 amounts for review. Automated native file selection was blocked by the Chrome extension's file-access setting, so the isolated QA page supplied the same synthetic PDF bytes through the file input; no extension permissions were changed. OCR execution against scanned taxpayer packets and exhaustive real-world statement layouts have not been verified by these tests.

Final PDF inspection also found and corrected existing Form 1040 liability mappings (lines 17, 18, 22, and 23), plus Schedule 2 AMT/additional-tax fields and its total-tax PDF field. A dedicated regression suite checks the distinction between nonrefundable credits, refundable credits, and other taxes. The updated mapping suite passed 61 tests. A later coverage audit must still check every form and field; the earlier broad suite does not establish exhaustive PDF correctness.

## Visual verification notes

The generated concept specified navy surfaces, orange active navigation, a three-column source/form/explanation workspace, a written/visual toggle, persistent Radio, and secondary game/bookkeeping navigation. Implementation follows that structure and typography system. Intentional differences: actual IRS 2025 pages replace illustrative concept forms and sample amounts; supported calculation rows replace the concept's approximate summary; native audio controls provide real seeking; responsive columns stack at smaller widths. Temporary synthetic test pages are excluded from production and removed after QA.
