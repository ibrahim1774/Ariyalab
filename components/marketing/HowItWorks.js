import { Fragment } from 'react';
import Card from '../ui/Card';
import SectionHead from './SectionHead';
import useReveal from './useReveal';
import section from './Section.module.css';
import styles from './HowItWorks.module.css';

const STEPS = [
  {
    title: 'Describe it',
    body: 'Tell us about your product, app, course or story. Or start from a video you like and we keep its pacing.',
  },
  {
    title: 'Pick your cast',
    body: 'We draw each character for you. Ask for a change and draw again, or make one look like your own picture.',
  },
  {
    title: 'Get your video',
    body: 'Check the storyboard, then generate. You download a captioned video that is ready to post.',
  },
];

export default function HowItWorks() {
  const ref = useReveal();
  return (
    <section id="how-it-works" ref={ref} className={section.section} data-section="how-it-works">
      <div className={section.wrap}>
        <SectionHead eyebrow="How it works" title={<>Make a story video in <em className="accent-word">3 steps</em></>} />
        <div className={styles.row}>
          {STEPS.map((s, i) => (
            <Fragment key={s.title}>
              {i > 0 && <span className={styles.arrow} aria-hidden="true">&rarr;</span>}
              <Card className={styles.step}>
                <span className={styles.num}>{i + 1}</span>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <p className={styles.stepBody}>{s.body}</p>
              </Card>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
