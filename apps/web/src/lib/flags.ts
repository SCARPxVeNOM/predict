/**
 * National-team name → ISO 3166-1 alpha-2 code, for the flag PNGs vendored in
 * /public/flags (downloaded from flagcdn.com — public domain). Names must
 * match the TxLINE feed's participant names.
 */
export const TEAM_ISO: Record<string, string> = {
  Argentina: 'ar', Australia: 'au', Austria: 'at', Belgium: 'be', Bolivia: 'bo',
  Brazil: 'br', Cameroon: 'cm', Canada: 'ca', Chile: 'cl', Colombia: 'co',
  'Costa Rica': 'cr', Croatia: 'hr', Denmark: 'dk', Ecuador: 'ec', Egypt: 'eg',
  England: 'gb-eng', France: 'fr', Germany: 'de', Ghana: 'gh', Greece: 'gr',
  Iran: 'ir', Iraq: 'iq', Italy: 'it', 'Ivory Coast': 'ci', Jamaica: 'jm',
  Japan: 'jp', Jordan: 'jo', Mexico: 'mx', Morocco: 'ma', Myanmar: 'mm',
  Netherlands: 'nl', 'New Zealand': 'nz', Nigeria: 'ng', Norway: 'no',
  Panama: 'pa', Paraguay: 'py', Peru: 'pe', Poland: 'pl', Portugal: 'pt',
  Qatar: 'qa', 'Saudi Arabia': 'sa', Scotland: 'gb-sct', Senegal: 'sn',
  Serbia: 'rs', 'South Africa': 'za', 'South Korea': 'kr', Spain: 'es',
  Sweden: 'se', Switzerland: 'ch', Tunisia: 'tn', Turkey: 'tr', USA: 'us',
  'United States': 'us', Ukraine: 'ua', Uruguay: 'uy', Uzbekistan: 'uz',
  Venezuela: 've', Vietnam: 'vn', Wales: 'gb-wls',
};

export function flagSrc(teamName: string | undefined | null): string | null {
  if (!teamName) return null;
  const iso = TEAM_ISO[teamName.trim()];
  return iso ? `/flags/${iso}.png` : null;
}

/** First known country name appearing in free text (AI market questions). */
export function flagFromText(text: string): string | null {
  for (const name of Object.keys(TEAM_ISO)) {
    if (text.includes(name)) return flagSrc(name);
  }
  return null;
}
