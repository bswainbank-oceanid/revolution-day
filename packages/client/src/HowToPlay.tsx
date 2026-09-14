// The launch screen's rules summary — verbatim from export/reference/
// "Revolution Day Intro.pdf", not a paraphrase, so it stays in sync with
// the printed one-pager. The three attribute/alarm icons are real crops
// from export/rulebook/07_icons_credits.png (the rulebook's own icon
// legend page), background-keyed to transparent — see
// packages/client/public/icons/ — not redrawn placeholders. The rulebook
// link points at Revolution-Day-Rulebook.pdf (public/, copied from
// export/rulebook/ — see that folder's own merge history).
export function HowToPlay() {
  return (
    <section className="how-to-play">
      <p>
        The day after rigging his own re-election, the president of a nation torn by civil war plans to travel
        across the capital city and consolidate his power. Powerful leaders within the regime and among the rebel
        forces are conspiring to assassinate the president, seize power, and pursue their own destiny on this
        fateful day.
      </p>
      <p>You will play one of these 8 leaders. Review your leader card to learn your particular victory conditions.</p>

      <h3>During your turn, you:</h3>
      <ul>
        <li>Draw a card</li>
        <li>Take two actions</li>
      </ul>

      <h3>As an action, you can do one of five things:</h3>
      <ul>
        <li>Draw a card</li>
        <li>Play a character card</li>
        <li>Play a motorcade card</li>
        <li>Move a character you control to an adjacent location</li>
        <li>Activate an Activate Ability on a character you control</li>
      </ul>

      <p>Characters can only be played at certain locations, as indicated by the icons on their cards.</p>

      <h3>Character cards can have special attributes:</h3>
      <ul className="how-to-play-icon-list">
        <li>
          <img src="/icons/blend.png" alt="Blend icon" className="how-to-play-icon" />
          <span>
            <strong>Blend</strong> — Blended cards are played face down and revealed when they use abilities and
            reactions
          </span>
        </li>
        <li>
          <img src="/icons/protected.png" alt="Protected icon" className="how-to-play-icon" />
          <span>
            <strong>Protected</strong> — Protected cards can not be eliminated while there are other cards of the
            same faction at their location
          </span>
        </li>
      </ul>

      <p className="how-to-play-alarm">
        <img src="/icons/alarm.png" alt="Alarm icon" className="how-to-play-icon" />
        <span>
          Some actions trigger an alarm — when an alarm is activated, each player has an opportunity to use a{" "}
          <strong>response</strong> ability on one of their cards at that location before the ability resolves.
        </span>
      </p>

      <p>
        The full rules are available in the{" "}
        <a href="/Revolution-Day-Rulebook.pdf" target="_blank" rel="noopener noreferrer">
          Revolution Day Rulebook
        </a>
        .
      </p>
    </section>
  );
}
