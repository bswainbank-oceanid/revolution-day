// Maps card_data.json's defRef strings and board location types to the
// real finished art in public/ (copied from export/cards, export/locations
// — see DESIGN_REFERENCE.md for the source). Explicit table rather than a
// slugify-defRef function: several cards have two art variants (_a/_b,
// e.g. two-copy cards like Bodyguard) with no way to derive which one a
// given card instance should use, and "Leader" is spelled into the
// filename only for leaders — not worth deriving when there are only ~28
// distinct entries to just list.
const CARD_ART: Record<string, string> = {
  "Head of Security": "01_regime_leader_head_of_security.png",
  "Commander General": "02_regime_leader_commander_general.png",
  Wife: "03_regime_leader_wife.png",
  "Heir Apparent": "04_regime_leader_heir_apparent.png",
  "Opposition Leader": "05_rebel_leader_opposition_leader.png",
  "Guerrilla Commander": "06_rebel_leader_guerrilla_commander.png",
  "Master Assassin": "07_rebel_leader_master_assassin.png",
  "Puppet-Master": "08_rebel_leader_puppet_master.png",
  Bodyguard: "09_regime_bodyguard_a.png",
  "Secret Police": "11_regime_secret_police_a.png",
  "Throng of Admirers": "13_regime_throng_of_admirers.png",
  Celebrity: "14_regime_celebrity.png",
  "Republican Guard": "15_regime_republican_guard_a.png",
  "Death Squad": "17_regime_death_squad_a.png",
  "Traffic Cop": "19_regime_traffic_cop_a.png",
  "Army Sniper": "21_regime_army_sniper.png",
  "Prominent Citizen": "22_regime_prominent_citizen_a.png",
  "Mr. Lucky": "24_rebel_mr_lucky.png",
  "Rebel Soldier": "25_rebel_rebel_soldier_a.png",
  Gunman: "27_rebel_gunman_a.png",
  Assassin: "29_rebel_assassin_a.png",
  "Angry Mob": "31_rebel_angry_mob_a.png",
  Martyr: "33_rebel_martyr.png",
  Journalist: "34_rebel_journalist.png",
  "Suicide Bomber": "35_rebel_suicide_bomber_a.png",
  "Insurgent Sniper": "37_rebel_insurgent_sniper.png",
  Anarchist: "38_rebel_anarchist.png",
  President: "39_regime_president.png",
  Motorcade: "40_motorcade_01.png",
};

export const CARD_BACK_URL = "/cards/card_back.png";

// null defRef means the card's identity is hidden from this viewer
// (filterForPlayer's redaction) — show the shared back, same as a
// face-down card whose identity happens to be known.
export function cardArtUrl(defRef: string | null): string {
  if (defRef === null) return CARD_BACK_URL;
  const file = CARD_ART[defRef];
  return file ? `/cards/${file}` : CARD_BACK_URL;
}

const STREET_VARIANTS = ["01_street_a.png", "02_street_b.png", "03_street_c.png"];
const LOCATION_ART: Record<string, string> = {
  Arena: "04_arena.png",
  HQ: "05_hq.png",
  Palace: "06_palace.png",
};

// Cycles through the 3 Street art variants by board position for a little
// visual variety — there's no meaningful identity to preserve between
// same-named Street locations, unlike the named ones.
export function locationArtUrl(locationName: string, streetIndex: number): string {
  const file = LOCATION_ART[locationName] ?? STREET_VARIANTS[streetIndex % STREET_VARIANTS.length]!;
  return `/locations/${file}`;
}
