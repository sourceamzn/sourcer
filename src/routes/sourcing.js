const { dispatch } = require("../adapters");

async function sourcing(req, res) {
  const { source, action } = req.params;
  const out = await dispatch(source, action, req.body || {});
  res.status(out.status).json(out.body);
}

module.exports = sourcing;
