import { useCallback, useState } from "react";

export type View = { readonly kind: "city" } | { readonly kind: "location"; readonly locationId: string };

interface UseViewNavigationResult {
  readonly view: View;
  readonly goToCity: () => void;
  readonly goToLocation: (locationId: string) => void;
}

// City View <-> Location View, per BUILD_PLAN.md step 4: starts in City
// View, a tile click goes to that location, the brown background outside
// the location image goes back to City View. Selecting an in-play card
// (wherever it's clickable) also lands here via goToLocation, so viewing
// a card and navigating to it are the same action rather than two.
export function useViewNavigation(): UseViewNavigationResult {
  const [view, setView] = useState<View>({ kind: "city" });
  const goToCity = useCallback(() => setView({ kind: "city" }), []);
  const goToLocation = useCallback((locationId: string) => setView({ kind: "location", locationId }), []);
  return { view, goToCity, goToLocation };
}
