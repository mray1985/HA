# HA return workspace

Open the packaged index.html to work through a fictional return. For installation and offline use, serve the contents of dist over HTTPS or localhost. Choose the browser’s Install or Add to Home Screen command. The example is a single, age-40 U.S. resident with only ordinary W-2 wages and federal withholding. Both dashboards link to the same practice workflow. No client records from either dashboard enter it.

## Try a return

1. Select 2025. Open **Import a practice W-2**, download the supplied fictional PDF, select it, inspect boxes 1 and 2, and confirm replacement of the initial example. The file has editable fields on the official W-2 Copy B background.
2. Choose line 16, switch between Written and Visual, or select a box on the source. The IRS pages, amount, source and explanation stay linked. The amount for $41,050 in wages is $2,801. With $3,500 withheld, the refund is $699.
3. Add another W-2. A blank box blocks calculation. Explicit zero enables calculation. Duplicate PDF bytes are detected. Changing an extracted field requires a reason. The draft records the before and after values and time. Remove or correct a W-2 and verify the updated review copy.
4. Print uses two marked review pages. Entering 2026 or leaving the verified sample scope disables the print action and clears the amounts. Operating-system printing is outside the app's control.
5. On a phone, move between Source, Form and Explanation. Tab with the keyboard to inspect line amounts. The accessible line selector offers a larger target than a printed IRS field.

## Build and verification

From the repository root, use the following commands. The checked-in dashboards already include built practice assets. Building regenerates both copies from one source. The archived portable HTML also includes its own practice W-2.

```sh
(cd individual && npm ci)
python -m pip install pymupdf lxml openpyxl playwright
python workspace-review/build.py
node workspace-review/tests/tax-table.cjs
python workspace-review/tests/pdf-mapping.py
python -m http.server 4860 --bind 127.0.0.1 --directory workspace-review/dist
# In another shell, set CHROMIUM to the installed Chromium executable.
python workspace-review/tests/browser.py http://127.0.0.1:4860/index.html
```

A browser with file access restrictions may require the localhost or HTTPS version. Mobile layout and offline replay were exercised in Chromium. Physical iOS and Android installation and assistive-technology acceptance remain open. The downloadable HTML works without an external AI key or vendor service.

## Evidence and scope

The build uses HA’s existing individual engine for the single standard deduction and line 16 Tax Table calculation. Inputs are decimal strings, summed in integer cents by W-2 box before whole-dollar rounding. The 2024 and 2025 official Form 1040 PDFs are byte-pinned, and the renderer derives and checks field positions from the official printed line labels. The year-specific pages are rasterized for the review view. Printed review pages are not a signed return or an accessible tagged filing PDF. The supported wage range is $40,000–$100,000 inclusive after rounding. Prior payments, refundable credits, estimated-tax penalties, other W-2 entries and any facts beyond the stated sample are outside this workflow.

The repo's individual and preparer applications retain separate engine copies. This practice workspace shares a single compiled implementation between them. Existing Schedule C, K-1, investment, credit, document-reading, vault and PDF code requires separate verification by year and return family before promotion into this workflow. Receiving a K-1 is a separate review task from creating the issuer’s 1065, 1120-S or 1041.

## Coverage files

- coverage.csv contains IRS prior-products catalog metadata by revision-year search, including publications and instructions. A year of publication alone cannot establish applicability. Continuous-use forms, amended instructions, corrections, worksheets internal to instructions, paper statements, current-year forms and elections need additional reconciliation.
- individual-mef.csv preserves the IRS public workbook’s counts for each return family, source URL, worksheet and row. A zero is the IRS workbook cell, not a paper-filing determination. Identifier matches are conservative. Entries without a match remain open. The IRS 2026 download has a 2025 worksheet tab name. Its entries are held for year confirmation.
- modules/ holds a year-by-year minimum-form review queue for each requested module. Missing catalog matches stay visible. Module counts do not establish complete coverage. Filing method, paper eligibility, signatures, attachments and deadlines remain open unless verified individually.
- Refresh with inventory.py, reconcile.py and modules.py, in that order. These scripts read public IRS product listings and the public individual accepted-form workbooks. IRS MeF XSDs, reject rules and ATS credentials are separate dependencies.
- The supported deduction and tax table authorities are the IRS Form 1040 instructions, archived at https://www.irs.gov/pub/irs-prior/i1040gi--2024.pdf and https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf. The sample W-2 background comes from https://www.irs.gov/pub/irs-prior/fw2--2025.pdf. To regenerate the practice PDF, run make-sample.cjs with the downloaded 2025 W-2 PDF as its argument.
- Separately filed obligations remain outside the submission package. For example, an applicable FBAR goes through FinCEN BSA E-Filing. Its general annual deadline is April 15 of the following year with an automatic extension to October 15. Check year-specific disaster relief. See https://www.irs.gov/irm/part9/irm_09-005-005.

## Operating boundary

Use fictional data. No service collects this workspace’s amounts. Import parses the supplied practice form locally, requires confirmation, and keeps its source bytes in memory. The current tab’s session storage holds a year-keyed practice draft, document digest, extracted values, corrections and reasons. The page does not send those to an OCR service, analytics, or a transmitter. A full reload restores the practice facts but releases the in-memory PDF. The service worker caches the static shell only. This slice introduces no server database migration. It uses the v1 tab-local practice data format. Closing the tab normally clears its session storage; browser session restoration can restore it. Clear site data to reset all practice drafts.

The case is never marked ready to file. The practice module has no production payment, signature or submission endpoint. A production release requires full intake and eligibility verification, year-specific PDF and XML reconciliation, role and client isolation checks, conflict-safe shared persistence, signed snapshot preservation, tested encrypted backup and recovery, WISP controls and vendor/use/disclosure review under section 7216. Add consent handling when the actual purpose and recipient require it. Operating references: https://www.irs.gov/tax-professionals/section-7216-information-center and https://www.irs.gov/e-file-providers/modernized-e-file-schema-and-business-rules-for-individual-tax-returns-and-extensions.

Production filing requires an authorized transmitter or HA’s applicable approved IRS provider roles, valid software identification, current schema/rule packages, successful applicable ATS testing and verified acknowledgment processing. Credentials were not supplied or exercised. Taxpayer portal access, invoices and reconciled fees, signatures, amendments and cross-year carryovers remain unverified for the new workflow. Service fees, IRS payments and taxpayer refunds have no combined payment route here.
