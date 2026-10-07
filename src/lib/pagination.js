'use strict';

function parsePagination(query = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), 100);
  let offset = 0;
  if (query.cursor) {
    try {
      offset = Math.max(Number.parseInt(Buffer.from(String(query.cursor), 'base64').toString('utf8'), 10) || 0, 0);
    } catch (err) {
      offset = 0;
    }
  } else if (query.offset) {
    offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  }
  return { limit, offset };
}

function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

function paginate(items, limit, offset, total) {
  const nextOffset = offset + items.length;
  const hasMore = total === undefined ? items.length === limit : nextOffset < total;
  return {
    items,
    nextCursor: hasMore ? encodeCursor(nextOffset) : null,
  };
}

module.exports = { parsePagination, paginate, encodeCursor };
