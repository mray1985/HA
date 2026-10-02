/**
 * What the Terms of Use and the Privacy Policy state about the business. The
 * pages are drafts from the governing rules (IRC §7216 and Treas. Reg.
 * §301.7216-1 to -3, Rev. Proc. 2013-14, IRC §6107 and §6713, the FTC
 * Safeguards Rule (16 CFR Part 314), Regulation P (12 CFR Part 1016)) and from
 * what the app does; have counsel review them, and fill every TODO, before
 * release.
 */
export const LEGAL = {
  /** TODO: the legal name of the company that licenses the app. */
  company: 'HA Tax',
  /** TODO: the support and privacy address. */
  contactEmail: 'contact@example.com',
  /** TODO: confirm the governing law (the District of Columbia is a placeholder). */
  governingLaw: 'the District of Columbia',
  /** The date both pages take effect. */
  effective: 'October 1, 2026',
  /**
   * TODO: true once every value above is the business's own and counsel has
   * reviewed both pages. The installer refuses a release build until then
   * (desktop/scripts/check-client.mjs), since sign-up accepts these terms.
   */
  confirmed: false,
} as const;
