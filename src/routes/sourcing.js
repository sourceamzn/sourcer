const { dispatch } = require("../adapters");
const store = require("../lib/store");

async function sourcing(req, res) {
  const { source, action } = req.params;
  const out = await dispatch(source, action, req.body || {});
  if (
    action === "browse" &&
    out.body &&
    out.body.ok &&
    out.body.data &&
    Array.isArray(out.body.data.items)
  ) {
    try {
      await store.catalogUpsert(source, out.body.data.items);
    } catch (e) {
      /* el barrido sigue siendo util aunque no se pueda registrar el historico */
    }
  }
  res.status(out.status).json(out.body);
}

module.exports = sourcing;
