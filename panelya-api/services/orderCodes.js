async function nextOrderCode(client) {
  const result = await client.query("select nextval('order_code_seq')::bigint as next");
  return `#${result.rows[0].next}`;
}

module.exports = {
  nextOrderCode,
};
