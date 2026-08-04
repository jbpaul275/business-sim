import { CARDS, factsFor } from '../server/cards';

/**
 * The scenario picker. Server component: everything on a card is either
 * editorial (the one-line dynamics) or computed from the template itself —
 * the opening cost comes from the same month-zero probe the funding screen
 * uses, and the earning band is the template's own sourced §13.3 band.
 *
 * Every path leads through the conversation. A template card SEEDS the
 * interview — the calibrated cost structure comes along, but the player
 * still says what the business actually is, funds it, and argues the
 * register before anything opens. Clicking a card used to drop the player
 * into the calibration reference fixture: a business they never chose,
 * capitalised by a test, losing money they had no say in. That is a
 * harness, not a game. The reference builds survive below, labelled as
 * what they are.
 */

export default function Home() {
  const cards = Object.entries(CARDS).map(([scenario, spec]) => ({
    scenario,
    spec,
    facts: factsFor(spec),
  }));

  return (
    <main className="picker">
      <h1>Business Sim</h1>
      <p className="sub">
        A deterministic engine, three statements that tie to the cent, and ten years to beat the
        index.
      </p>

      <a className="hero-card" href="/new">
        <div className="hero-title">Describe your own business</div>
        <div className="hero-sub">
          A sentence is enough. The model asks what it needs, drafts every number with its source —
          and you argue with any of them before a dollar is committed.
        </div>
        <span className="hero-go">Start the conversation →</span>
      </a>

      <div className="divider">or seed the conversation with a calibrated template</div>

      <div className="scenario-grid">
        {cards.map(({ scenario, spec, facts }) => (
          <a className="scenario-card" href={`/new?seed=${scenario}`} key={scenario}>
            <div className="name">{spec.name}</div>
            <div className="blurb">{spec.blurb}</div>
            <div className="facts">
              <span>{facts.toOpen}</span>
              {facts.band && <span>{facts.band}</span>}
            </div>
            <div className="go">Seed the conversation →</div>
          </a>
        ))}
      </div>
      <p className="picker-foot">
        Every template is calibrated against published operating benchmarks — the EBITDA bands above
        are the ranges its own test suite holds it to. Seeding starts the same conversation with the
        template&apos;s cost structure ready to borrow; what the business actually is stays yours to
        decide.
      </p>
    </main>
  );
}
