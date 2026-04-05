// Vercel-compatible disconnect endpoint

export default function handler(req, res) {
    if (req.method === 'POST') {
        // Implement your disconnect logic here
        res.status(200).json({ message: 'Disconnected successfully' });
    } else {
        res.setHeader('Allow', ['POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}