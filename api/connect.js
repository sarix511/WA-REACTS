export default function handler(req, res) {
  if (req.method === 'POST') {
    // Handle the pairing code logic here
    const pairingCode = generatePairingCode();
    res.status(200).json({ pairingCode });
  } else {
    // If the request isn't a POST, return a 405 Method Not Allowed
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

function generatePairingCode() {
  // Generate a random pairing code
  return Math.floor(100000 + Math.random() * 900000).toString();
}