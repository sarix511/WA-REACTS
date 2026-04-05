export default async function handler(req, res) {
  if (req.method === 'POST') {
    // Your logic to send a reaction
    res.status(200).json({ message: 'Reaction sent successfully!' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}