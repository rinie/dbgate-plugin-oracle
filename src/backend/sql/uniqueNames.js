module.exports = `
    select conname as "constraint_name" from pg_constraint where contype = 'u'
`;
