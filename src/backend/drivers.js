const _ = require('lodash');
const stream = require('stream');

const driverBases = require('../frontend/drivers');
const Analyser = require('./Analyser');
//--const pg = require('pg');
const oracledb = require('oracledb');
const { createBulkInsertStreamBase, makeUniqueColumnNames } = require('dbgate-tools');

/*
pg.types.setTypeParser(1082, 'text', val => val); // date
pg.types.setTypeParser(1114, 'text', val => val); // timestamp without timezone
pg.types.setTypeParser(1184, 'text', val => val); // timestamp
*/

function extractOracleColumns(result) {
      console.log('result', result);
      console.log('result.name', result[0].name);
      console.log('result.map', result.map(fld => ({
    columnName: fld.name.toLowerCase(),
  })));
  if (!result /*|| !result.fields */) return [];
  const res = result.map(fld => ({
    columnName: fld.name.toLowerCase(),
  }));
  makeUniqueColumnNames(res);
  return res;
}

function zipDataRow(rowArray, columns) {
  return _.zipObject(
    columns.map(x => x.columnName),
    rowArray
  );
}

/** @type {import('dbgate-types').EngineDriver} */
const drivers = driverBases.map(driverBase => ({
  ...driverBase,
  analyserClass: Analyser,

  async connect({
    engine,
    server,
    port,
    user,
    password,
    database,
    databaseUrl,
    useDatabaseUrl,
    ssl,
    isReadOnly,
    authType,
    socketPath,
  }) {
    let options = null;

    if (engine == 'redshift@dbgate-plugin-oracle') {
      let url = databaseUrl;
      if (url && url.startsWith('jdbc:redshift://')) {
        url = url.substring('jdbc:redshift://'.length);
      }
      if (user && password) {
        url = `oracle://${user}:${password}@${url}`;
      } else if (user) {
        url = `oracle://${user}@${url}`;
      } else {
        url = `oracle://${url}`;
      }

      options = {
        connectionString: url,
      };
    } else {
      options = useDatabaseUrl
        ? {
            connectionString: databaseUrl,
          }
        : {
            host: authType == 'socket' ? socketPath || driverBase.defaultSocketPath : server,
            port: authType == 'socket' ? null : port,
            user,
            password,
            database: database || 'oracle',
            ssl,
          };
    }

    console.log('OPTIONS', options);
/*
    const client = new pg.Client(options);
    await client.connect();

    if (isReadOnly) {
      await this.query(client, 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    }
*/
  client = await oracledb.getConnection( {
      user          : options.user,
      password      : options.password,
      connectString : options.host
    });
    return client;
  },
  async close(pool) {
    return pool.end();
  },
  async query(client, sql) {
    if (sql == null) {
      return {
        rows: [],
        columns: [],
      };
    }
      console.log('sql', sql);
    const res = await client.execute(sql);
      console.log('res', res);
    const columns = extractOracleColumns(res.metaData);
      console.log('columns', columns);
    return { rows: (res.rows || []).map(row => zipDataRow(row, columns)), columns };
  },
  stream(client, sql, options) {
    /*
    const query = new pg.Query({
      text: sql,
      rowMode: 'array',
    });
*/
      console.log('queryStream', sql);
    const query = client.queryStream(sql);
    let wasHeader = false;

    query.on('metaData', row => {
      console.log('metaData', row);
      if (!wasHeader) {
        columns = extractOracleColumns(query.metaData);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.row(zipDataRow(row, columns));
    });

    query.on('data', row => {
      console.log('DATA', row);
      if (!wasHeader) {
        columns = extractOracleColumns(query._result);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.row(zipDataRow(row, columns));
    });

    query.on('end', () => {
      const { command, rowCount } = query._result || {};

      if (command != 'SELECT' && _.isNumber(rowCount)) {
        options.info({
          message: `${rowCount} rows affected`,
          time: new Date(),
          severity: 'info',
        });
      }

      if (!wasHeader) {
        columns = extractOracleColumns(query._result);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.done();
    });

    query.on('error', error => {
      console.log('ERROR', error);
      const { message, lineNumber, procName } = error;
      options.info({
        message,
        line: lineNumber,
        procedure: procName,
        time: new Date(),
        severity: 'error',
      });
      options.done();
    });

    client.query(query);
  },
  async getVersion(client) {
    //const { rows } = await this.query(client, "SELECT banner as version FROM v$version WHERE banner LIKE 'Oracle%'");
    const { rows } = await this.query(client, "SELECT version FROM v$instance");
    const { version } = rows[0];

    const isCockroach = false; //version.toLowerCase().includes('cockroachdb');
    const isRedshift = false; // version.toLowerCase().includes('redshift');
    const isOracle = true;

    const m = version.match(/([\d\.]+)/);
    //console.log('M', m);
    let versionText = null;
    let versionMajor = null;
    let versionMinor = null;
    if (m) {
      if (isOracle) versionText = `Oracle ${m[1]}`;
      const numbers = m[1].split('.');
      if (numbers[0]) versionMajor = parseInt(numbers[0]);
      if (numbers[1]) versionMinor = parseInt(numbers[1]);
    }

    return {
      version,
      versionText,
      isOracle,
      isCockroach,
      isRedshift,
      versionMajor,
      versionMinor,
    };
  },
  async readQuery(client, sql, structure) {
/*
    const query = new pg.Query({
      text: sql,
      rowMode: 'array',
    });
*/
    console.log('readQuery', sql, structure);
    const query = await client.queryStream(sql);

    let wasHeader = false;
    let columns = null;

    const pass = new stream.PassThrough({
      objectMode: true,
      highWaterMark: 100,
    });

    query.on('data', row => {
      if (!wasHeader) {
        columns = extractOracleColumns(query._result);
        pass.write({
          __isStreamHeader: true,
          ...(structure || { columns }),
        });
        wasHeader = true;
      }

      pass.write(zipDataRow(row, columns));
    });

    query.on('end', () => {
      if (!wasHeader) {
        columns = extractOracleColumns(query._result);
        pass.write({
          __isStreamHeader: true,
          ...(structure || { columns }),
        });
        wasHeader = true;
      }

      pass.end();
    });

    query.on('error', error => {
      console.error(error);
      pass.end();
    });

    client.query(query);

    return pass;
  },
  async writeTable(pool, name, options) {
    // @ts-ignore
    return createBulkInsertStreamBase(this, stream, pool, name, options);
  },
  async listDatabases(client) {
    const { rows } = await this.query(client, 'SELECT instance_name AS name FROM v$instance');
    return rows;
  },

  getAuthTypes() {
    return [
      {
        title: 'Host and port',
        name: 'hostPort',
      },
      {
        title: 'Socket',
        name: 'socket',
      },
    ];
  },
}));

module.exports = drivers;