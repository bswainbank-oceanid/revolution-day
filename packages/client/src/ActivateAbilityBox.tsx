import { cardData, getAbilities } from "@rev-day/engine";
import type { FilteredCardInstance } from "@rev-day/engine";

interface ActivateAbilityBoxProps {
  readonly card: FilteredCardInstance | null;
}

// Step 3 (static content pass): lists the viewed card's abilities with
// real text, but the buttons are inert — wiring them up (activateAbility/
// useResponse/interceptMotorcade, and the Choose Targets/View Cards
// toggle once one's picked) is step 6 per BUILD_PLAN.md.
export function ActivateAbilityBox({ card }: ActivateAbilityBoxProps) {
  if (!card || card.defRef === null) {
    return (
      <div className="activate-ability-box">
        <h3>ACTIVATE ABILITY</h3>
        <p className="hint">No abilities</p>
      </div>
    );
  }

  const abilities = getAbilities(cardData, { ...card, defRef: card.defRef }).filter((a) => a.type === "Activate");

  return (
    <div className="activate-ability-box">
      <h3>ACTIVATE ABILITY</h3>
      {abilities.length === 0 ? (
        <p className="hint">No abilities{card.defRef === "President" ? " — Protected" : ""}</p>
      ) : (
        abilities.map((ability, i) => (
          <button key={i} type="button" className="ability-button" disabled>
            {ability.text}
          </button>
        ))
      )}
    </div>
  );
}
