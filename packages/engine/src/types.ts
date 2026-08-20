export type Faction = "Regime" | "Rebel";
export type LocationType = "Street" | "Secure" | "Public";
export type Attribute = "Protected" | "Blend";
export type AbilityType = "Activate" | "Response";

export interface Ability {
  type: AbilityType;
  text: string;
  alarm?: boolean;
}

export interface LeaderCard {
  name: string;
  faction: Faction;
  locations: LocationType[];
  attributes: Attribute[];
  win_conditions: string[];
  abilities: Ability[];
}

export interface NonLeaderCard {
  name: string;
  faction: Faction;
  copies: number;
  locations: LocationType[];
  attributes: Attribute[];
  abilities?: Ability[];
  passive?: string;
}

export interface PresidentData {
  name: string;
  faction: string;
  attributes: Attribute[];
  notes: string;
}

export interface MotorcadeData {
  name: string;
  count_in_deck: number;
  text: string;
  notes: string;
}

export interface CardData {
  game: string;
  designer: string;
  publisher: string;
  players: string;
  playtime_minutes: string;
  locations_in_order: string[];
  location_types: Record<string, LocationType>;
  leaders: LeaderCard[];
  president: PresidentData;
  motorcade: MotorcadeData;
  non_leader_cards: NonLeaderCard[];
  attributes: Record<Attribute, string>;
  alarm_response_rules: string[];
  turn_structure: {
    draw_phase: string;
    action_phase: string;
  };
  ending_the_game: string;
  additional_rulings: string[];
}
