// SPDX-License-Identifier: Apache-2.0
import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(express.static('public'));

app.get('/api/hello', (req, res) => {
  res.json({ message: `Hello, ${req.query.name ?? 'world'}!`, time: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
