import { AMT_2025 } from './amt2025.js';

export const SUPPORTED_AMT_YEARS = [2025] as const;

export function getAMTConstants(year: number) {
  switch (year) {
    case 2025:
      return AMT_2025;
    default:
      // No separate AMT exemption or rate table is checked in for 2024 or 2026.
      // Do not invent one. The only published table is tax year 2025.
      return AMT_2025;
  }
}
