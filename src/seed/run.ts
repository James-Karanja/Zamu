import { databasePath } from '../db/connection.ts';
import { seedDatabase } from './data.ts';

const path = databasePath();
const counts = seedDatabase(path);
console.log(`Seeded ${path}`);
console.table(counts);
