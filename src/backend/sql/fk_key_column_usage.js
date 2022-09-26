module.exports = `
select 
	basecol.constraint_name,
	basecol.constraint_schema,
	basecol.column_name as "column_name",
	basecol.table_schema,
	basecol.table_name,
	basecol.ordinal_position
from  information_schema.key_column_usage basecol
`;
