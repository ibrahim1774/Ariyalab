import { useState } from 'react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Pill from '../ui/Pill';
import SectionHead from './SectionHead';
import useReveal from './useReveal';
import useStartHref from './useStartHref';
import { PLANS, YEARLY_DISCOUNT, videosFor } from './pricingData';
import section from './Section.module.css';
import styles from './PricingSection.module.css';

const CARDS = [
  { key: 'starter', name: 'Starter', blurb: 'For trying the idea on a real project.' },
  { key: 'creator', name: 'Creator', blurb: 'For a steady flow of videos each month.', popular: true },
  { key: 'studio', name: 'Studio', blurb: 'For teams and heavy posting schedules.' },
];

const TICKS = ['Cancel any time', 'Secure checkout', 'Plan credits roll over for one month', 'Top-up credits never expire'];

function money(n, yearly) {
  return yearly ? `$${n.toFixed(2)}` : `$${n}`;
}

export default function PricingSection() {
  const ref = useReveal();
  const startHref = useStartHref();
  const [yearly, setYearly] = useState(false);

  return (
    <section id="pricing" ref={ref} className={section.section} data-section="pricing">
      <div className={section.wrap}>
        <SectionHead
          eyebrow="Pricing"
          title={<>Simple, <em className="accent-word">honest</em> pricing</>}
          lede="Pick a monthly plan. You see the exact credit cost of a video before you confirm it."
        />

        <div className={styles.toggle} role="group" aria-label="Billing period">
          <button type="button" aria-pressed={!yearly} className={`${styles.opt} ${!yearly ? styles.on : ''}`} onClick={() => setYearly(false)}>
            Monthly
          </button>
          <button type="button" aria-pressed={yearly} className={`${styles.opt} ${yearly ? styles.on : ''}`} onClick={() => setYearly(true)}>
            Yearly
            <span className={styles.save}>Save {Math.round(YEARLY_DISCOUNT * 100)}%</span>
          </button>
        </div>

        <div className={styles.grid}>
          {CARDS.map((c) => {
            const plan = PLANS[c.key];
            const monthly = yearly ? plan.usd * (1 - YEARLY_DISCOUNT) : plan.usd;
            const dark = Boolean(c.popular);
            return (
              <Card key={c.key} tone={dark ? 'dark' : 'light'} className={styles.plan} data-plan={c.key}>
                <div className={styles.top}>
                  <h3 className={styles.name}>{c.name}</h3>
                  {dark && <Pill tone="accent">Most popular</Pill>}
                </div>
                <p className={styles.blurb}>{c.blurb}</p>
                <div className={styles.price}>
                  <span className={styles.amount}>{money(monthly, yearly)}</span>
                  <span className={styles.per}>per month</span>
                </div>
                <p className={styles.billed}>
                  {yearly ? `Billed yearly at ${money(plan.usd * 12 * (1 - YEARLY_DISCOUNT), true)}` : 'Billed monthly'}
                </p>
                <ul className={styles.list}>
                  <li>{plan.credits.toLocaleString('en-US')} credits each month</li>
                  <li>About {videosFor(plan.credits)} videos of 45 seconds</li>
                  <li>Captions and music included</li>
                </ul>
                <Button href={startHref} variant={dark ? 'primary' : 'ghost'} className={styles.cta}>
                  Get started
                </Button>
              </Card>
            );
          })}
        </div>

        <ul className={styles.ticks}>
          {TICKS.map((t) => (
            <li key={t}><span aria-hidden="true">&#10003;</span> {t}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
