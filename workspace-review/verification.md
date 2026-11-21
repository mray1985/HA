# Verification record

| Check | Result |
|---|---|
| Repository base | mray1985/HA at f4978a241a736dc8cab06d258d4a541e810a21ee |
| Input PDFs | Bundled 2024 and 2025 1040 templates matched IRS downloads byte for byte |
| IRS Tax Tables | 4,802 in-scope endpoint comparisons passed across 2024 and 2025 |
| Amount handling | Missing versus zero, invalid precision, whole-dollar rounding and outside-range rejection passed |
| Original application mappings | 30 import/export mappings checked against printed IRS labels across both applications |
| Desktop Chromium | Confirm PDF extraction, duplicate rejection, draft recovery, correction reason, linked selection, refund and balance |
| Phone-width Chromium | Tab selection maintained across panels; no horizontal overflow in the tested viewport |
| Review and offline use | Two letter-sized review pages with a synthetic mark on each; offline browser reload passed |
| Existing suites | Individual engine 5,243 and client 1,031; preparer engine 5,253 and client 1,130 tests passed |
| Build | Individual and preparer production web builds completed |
| Live filing | Disabled. No transmissions, acknowledgments, ATS or signed return packaging were tested |
| Coverage | 1,844 IRS prior-product catalog records. 4,718 form/return-family cells from public individual MeF workbooks, including zero values. Each separate module queue records gaps. |

The public IRS 2026 workbook URL is year-specific, while its worksheet tab reads taxyear2025 processingyear2026. Resolve that discrepancy before promoting any 2026 record. The verified workspace is restricted to the documented synthetic household. Unit-test counts alone cannot establish tax-law coverage or production privacy compliance.
