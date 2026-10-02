/**
 * What the Terms of Use and the Privacy Policy state about the business. The
 * pages are drafts from the governing rules (IRC §7216 and Treas. Reg.
 * §301.7216-1 to -3, Rev. Proc. 2013-14, IRC §6107 and §6713, the FTC
 * Safeguards Rule (16 CFR Part 314), Regulation P (12 CFR Part 1016)) and from
 * what the app does; have counsel review them, and fill every TODO, before
 * release.
 */
export const LEGAL = {
  /** The company that licenses the app. */
  company: 'HATax',
  /** Where questions about the terms and privacy go. */
  address: '447 Tilley Street, DeRidder, LA 70634',
  /** TODO: a support and privacy email address; until there is one, the pages give the postal address. */
  contactEmail: '',
  /** The governing law (the company is in Louisiana). */
  governingLaw: 'the State of Louisiana',
  /** The date both pages take effect. */
  effective: 'October 1, 2026',
  /**
   * TODO: true once counsel has reviewed both pages. Until then the pages say
   * they are drafts, and the installer builds only a marked test build
   * (desktop/scripts/check-client.mjs; npm run dist:test).
   */
  confirmed: false,
} as const;
