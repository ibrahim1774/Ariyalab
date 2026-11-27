import LegalPage from '../components/marketing/LegalPage';

const SECTIONS = [
  {
    heading: 'Who we are',
    body: [
      'Sonallo (sonallo.com) makes animated story videos from a short description. This policy explains what information we collect when you use Sonallo and how we use it.',
    ],
  },
  {
    heading: 'What we collect',
    body: [
      'Account details: your email address and, if you sign in with Google, your name and profile picture from your Google account.',
      'What you make: the stories, scripts, pictures, voices, uploads and videos you create or add to Sonallo.',
      'Billing: your plan, credits and purchase history. Payments are handled by Stripe. We never see or store your full card number.',
      'Usage: basic technical data such as pages visited, device and browser type, and error logs, so we can keep the service working.',
    ],
  },
  {
    heading: 'How we use it',
    body: [
      'To run your account, make your videos, process payments, answer support requests, prevent abuse, and improve Sonallo.',
      'We use advertising and analytics tools (such as Meta and TikTok pixels) to measure our ads. We do not sell your personal information.',
    ],
  },
  {
    heading: 'Who we share it with',
    body: [
      'Service providers that help us run Sonallo: hosting (Vercel), database and sign-in (Supabase), payments (Stripe), file storage, and the AI providers that generate pictures, video and voice from your prompts. They may only use your information to provide their service to us.',
      'We may also share information if the law requires it.',
    ],
  },
  {
    heading: 'Google user data',
    body: [
      'If you sign in with Google, we only receive your basic profile (name, email address and profile picture). We use it only to create and sign you in to your Sonallo account, and we do not share it with anyone else. Our use of information received from Google follows the Google API Services User Data Policy, including the Limited Use requirements.',
    ],
  },
  {
    heading: 'How long we keep it',
    body: [
      'We keep your account information while your account is open. Project files may be deleted automatically after a retention period shown in the app. You can ask us to delete your account and data at any time.',
    ],
  },
  {
    heading: 'Your choices',
    body: [
      'You can see and change your account details in the app, cancel your plan at any time from Billing, and email us to access, correct or delete your data.',
    ],
  },
  {
    heading: 'Changes',
    body: ['If we change this policy, we will update the date at the top of this page.'],
  },
];

export default function Privacy() {
  return <LegalPage title="Privacy Policy" updated="November 26, 2026" sections={SECTIONS} />;
}
