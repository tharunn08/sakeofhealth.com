/**
 * Reference data: Indian states with GST state codes, Karnataka districts,
 * starter categories and the first warehouse. Everything is INSERT IGNORE /
 * insert-if-missing, so re-running never overwrites what an admin has edited.
 */
const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
];

const KARNATAKA_DISTRICTS = [
  'Bagalkote', 'Ballari', 'Belagavi', 'Bengaluru Rural', 'Bengaluru Urban', 'Bidar', 'Chamarajanagara',
  'Chikkaballapura', 'Chikkamagaluru', 'Chitradurga', 'Dakshina Kannada', 'Davanagere', 'Dharwad', 'Gadag',
  'Hassan', 'Haveri', 'Kalaburagi', 'Kodagu', 'Kolar', 'Koppal', 'Mandya', 'Mysuru', 'Raichur', 'Ramanagara',
  'Shivamogga', 'Tumakuru', 'Udupi', 'Uttara Kannada', 'Vijayanagara', 'Vijayapura', 'Yadgir',
];

const CATEGORIES = [['Gummies', 'gummies', 1], ['Biscuits', 'biscuits', 2], ['Energy Drinks', 'energy-drinks', 3]];

async function up(conn) {
  for (const s of STATES) {
    await conn.raw.query(
      'INSERT IGNORE INTO b2b_states (country_code, name, gst_code, is_serviceable) VALUES (?, ?, ?, ?)',
      ['IN', s[1], s[0], s[0] === '29' ? 1 : 0]);
  }
  const [[ka]] = await conn.raw.query("SELECT id FROM b2b_states WHERE country_code = 'IN' AND gst_code = '29'");
  for (const d of KARNATAKA_DISTRICTS) {
    await conn.raw.query('INSERT IGNORE INTO b2b_districts (state_id, name) VALUES (?, ?)', [ka.id, d]);
  }
  for (const c of CATEGORIES) {
    await conn.raw.query('INSERT IGNORE INTO b2b_categories (name, slug, sort_order) VALUES (?, ?, ?)', c);
  }
  const [[wh]] = await conn.raw.query('SELECT COUNT(*) AS n FROM b2b_warehouses');
  if (Number(wh.n) === 0) {
    await conn.raw.query(
      'INSERT INTO b2b_warehouses (code, name, state_id, city, priority) VALUES (?, ?, ?, ?, ?)',
      ['BLR-MAIN', 'Bengaluru Main Warehouse', ka.id, 'Bengaluru', 100]);
  }
}

module.exports = { up };
