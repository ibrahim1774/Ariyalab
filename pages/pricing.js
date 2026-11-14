// /pricing lives on the homepage now.
export default function Pricing() {
  return null;
}

export function getServerSideProps() {
  return { redirect: { destination: '/#pricing', permanent: false } };
}
