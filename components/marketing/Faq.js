import Accordion from '../ui/Accordion';
import SectionHead from './SectionHead';
import useReveal from './useReveal';
import section from './Section.module.css';

const ITEMS = [
  {
    id: 'what',
    title: 'What is Ariya Lab?',
    body: 'Ariya Lab turns an idea into a finished animated story video. You describe it, pick your cast, review a storyboard, and we generate the shots, add narration, music and captions, and put it all together.',
  },
  {
    id: 'who',
    title: 'What kinds of business is it for?',
    body: 'Any of them. Physical products, apps and software, coaching and courses, local services, personal brands, or a story that has no pitch at all. The offer is mentioned once, naturally, by the character who would really say it.',
  },
  {
    id: 'quality',
    title: 'What are the quality levels?',
    body: 'Budget is 720p and good for quick drafts. Standard is 1080p and the one most people pick. Pro is 720p and Pro Max is 1080p, both from Kling 3.0. Every level makes voice and sound together with the video. You choose a level per project and can change it for a single shot.',
  },
  {
    id: 'credits',
    title: 'How do credits work?',
    body: 'Credits pay for the video seconds we generate. Before anything is generated you see the exact cost and confirm it. Plan credits roll over for one month, and top-up credits never expire.',
  },
  {
    id: 'reference',
    title: 'Can I start from a video I like?',
    body: 'Yes. Upload a file or paste a link from Instagram, TikTok, Facebook or the Meta Ad Library. We break it down shot by shot, then write a new script with new characters and a new setting that keeps the same pacing.',
  },
  {
    id: 'own',
    title: 'Do I own the videos I make?',
    body: 'The videos you make are yours to post on your own channels and ads. You are responsible for what they claim, and for having the right to any footage, images or voices you upload.',
  },
  {
    id: 'cancel',
    title: 'Can I cancel whenever I want?',
    body: 'Yes. You can cancel your plan at any time and keep access until the end of the period you already paid for.',
  },
  {
    id: 'claude',
    title: 'Can I use it from Claude?',
    body: 'Yes. Ariya Lab has a connector for Claude. You add its address in Claude, sign in with your Ariya Lab account, and you can make videos by chatting. It uses the same credits and always shows a quote before it spends any.',
  },
];

export default function Faq() {
  const ref = useReveal();
  return (
    <section id="faq" ref={ref} className={section.section} data-section="faq">
      <div className={section.wrap} style={{ maxWidth: 760 }}>
        <SectionHead eyebrow="FAQ" title={<>Questions, briefly <em className="accent-word">answered</em></>} />
        <Accordion items={ITEMS} />
      </div>
    </section>
  );
}
