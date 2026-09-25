import { AMT_2025 } from './amt2025.js';

export const SUPPORTED_AMT_YEARS = [2025] as const;

export function getAMTConstants(year: number) {
  switch (year) {
    default: return AMT_2025;
  }
}
