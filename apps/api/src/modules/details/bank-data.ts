// Seed data for section 5.4.2 (and section 14 "Banks (observed list) and the observed branch
// names"). The source showed 40 banks, starting with ABN Amro Bank, ABSA, African Bank, Bank of
// Athens, Bank of Windhoek and ending with Bank BIC and Bank Atlantico; the names in between are
// reconstructed (ASSUMPTION A50). Branch codes were not visible (ASSUMPTION A12): only the four
// Namibian banks get a universal code, and the branch codes are placeholders HR must confirm.

export interface SeedBank {
  name: string;
  country: string | null;
  universalBranchCode: string | null;
}

export const SEED_BANKS: readonly SeedBank[] = [
  { name: 'ABN Amro Bank', country: null, universalBranchCode: null },
  { name: 'ABSA', country: 'ZA', universalBranchCode: null },
  { name: 'African Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Bank of Athens', country: 'ZA', universalBranchCode: null },
  { name: 'Bank of Windhoek', country: 'NA', universalBranchCode: '483872' },
  { name: 'Bidvest Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Capitec Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Citibank', country: null, universalBranchCode: null },
  { name: 'Discovery Bank', country: 'ZA', universalBranchCode: null },
  { name: 'First National Bank', country: 'ZA', universalBranchCode: null },
  { name: 'FNB Namibia', country: 'NA', universalBranchCode: '280172' },
  { name: 'Grindrod Bank', country: 'ZA', universalBranchCode: null },
  { name: 'HBZ Bank', country: 'ZA', universalBranchCode: null },
  { name: 'HSBC Bank', country: null, universalBranchCode: null },
  { name: 'Investec Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Ithala Bank', country: 'ZA', universalBranchCode: null },
  { name: 'JP Morgan Chase Bank', country: null, universalBranchCode: null },
  { name: 'Letshego Bank Namibia', country: 'NA', universalBranchCode: null },
  { name: 'Mercantile Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Nedbank', country: 'ZA', universalBranchCode: null },
  { name: 'Nedbank Namibia', country: 'NA', universalBranchCode: '461038' },
  { name: 'Old Mutual Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Postbank', country: 'ZA', universalBranchCode: null },
  { name: 'Rand Merchant Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Sasfin Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Société Générale', country: null, universalBranchCode: null },
  { name: 'Standard Bank', country: 'ZA', universalBranchCode: null },
  { name: 'Standard Bank Namibia', country: 'NA', universalBranchCode: '087373' },
  { name: 'Standard Chartered Bank', country: null, universalBranchCode: null },
  { name: 'State Bank of India', country: null, universalBranchCode: null },
  { name: 'TymeBank', country: 'ZA', universalBranchCode: null },
  { name: 'Trustco Bank Namibia', country: 'NA', universalBranchCode: null },
  { name: 'Banco Angolano de Investimentos', country: 'AO', universalBranchCode: null },
  { name: 'Banco de Fomento Angola', country: 'AO', universalBranchCode: null },
  { name: 'Banco de Poupança e Crédito', country: 'AO', universalBranchCode: null },
  { name: 'Banco Sol', country: 'AO', universalBranchCode: null },
  { name: 'Banco Económico', country: 'AO', universalBranchCode: null },
  { name: 'Banco Keve', country: 'AO', universalBranchCode: null },
  { name: 'Bank BIC', country: 'AO', universalBranchCode: null },
  { name: 'Bank Atlantico', country: 'AO', universalBranchCode: null },
];

/** Branches observed for Bank Windhoek (seeded on "Bank of Windhoek") and FNB Namibia. */
const OBSERVED_BRANCHES = [
  'Universal Code',
  'Main Branch',
  'Exclusive Banking',
  'Oshikango',
  'Ausspanplatz',
  'Swakopmund',
  'Katutura',
] as const;

const WINDHOEK_BRANCHES = [
  ...OBSERVED_BRANCHES,
  'Walvis Bay',
  'Oshakati',
  'Ondangwa',
  'Rundu',
  'Otjiwarongo',
  'Tsumeb',
  'Keetmanshoop',
  'Lüderitz',
  'Gobabis',
  'Rehoboth',
  'Mariental',
  'Okahandja',
  'Grootfontein',
  'Katima Mulilo',
  'Maerua Mall',
  'Wernhil Park',
  'Henties Bay',
] as const;

const FNB_BRANCHES = [
  ...OBSERVED_BRANCHES,
  'Klein Windhoek',
  'Eros',
  'Walvis Bay',
  'Oshakati',
  'Ondangwa',
  'Rundu',
  'Otjiwarongo',
  'Tsumeb',
  'Keetmanshoop',
  'Lüderitz',
  'Gobabis',
  'Rehoboth',
  'Mariental',
  'Okahandja',
  'Outjo',
  'Katima Mulilo',
  'Henties Bay',
] as const;

export interface SeedBranch {
  name: string;
  code: string;
}

function branches(names: readonly string[], universal: string, prefix: string): SeedBranch[] {
  return names.map((name, index) => ({
    name,
    code: name === 'Universal Code' ? universal : `${prefix}${String(index).padStart(4, '0')}`,
  }));
}

/** Bank name → branches. Codes other than the universal code are placeholders (ASSUMPTION A12). */
export const SEED_BRANCHES: Readonly<Record<string, readonly SeedBranch[]>> = {
  'Bank of Windhoek': branches(WINDHOEK_BRANCHES, '483872', '48'),
  'FNB Namibia': branches(FNB_BRANCHES, '280172', '28'),
};
