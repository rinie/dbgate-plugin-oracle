const _ = require('lodash');
const stream = require('stream');

const driverBases = require('../frontend/drivers');
const Analyser = require('./Analyser');
//--const pg = require('pg');
//const oracledb = require('oracledb');
let oracledb; // native module
const { createBulkInsertStreamBase, makeUniqueColumnNames } = require('dbgate-tools');

/*
pg.types.setTypeParser(1082, 'text', val => val); // date
pg.types.setTypeParser(1114, 'text', val => val); // timestamp without timezone
pg.types.setTypeParser(1184, 'text', val => val); // timestamp
*/

function extractOracleColumns(result) {
  if (!result /*|| !result.fields */) return [];
  const res = result.map(fld => ({
    columnName: fld.name, //columnName: fld.name.toLowerCase(),
  }));
  makeUniqueColumnNames(res);
  return res;
}

function zipDataRow(rowArray, columns) {
  let obj = _.zipObject(
    columns.map(x => x.columnName),
    rowArray
  );
  //console.log('zipDataRow columns', columns);
  //console.log('zipDataRow', obj);
  return obj;
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
      //console.log('query sql', sql);
    if (sql == null) {
      return {
        rows: [],
        columns: [],
      };
    }
try {
      //console.log('sql3', sql);
    const res = await client.execute(sql);
    //console.log('res', res);
    const columns = extractOracleColumns(res.metaData);
     //console.log('columns', columns);
    return { rows: (res.rows || []).map(row => zipDataRow(row, columns)), columns };
}
catch(err) {
  console.log('Error query', err, sql);
}
finally {
  //console.log('finally', sql);
}

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
   // const consumeStream = new Promise((resolve, reject) => {
      let rowcount = 0;
    let wasHeader = false;

    query.on('metadata', row => {
      console.log('metadata', row);
      if (!wasHeader) {
        columns = extractOracleColumns(row);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.row(zipDataRow(row, columns));
    });

    query.on('data', row => {
      console.log('stream DATA');
      if (!wasHeader) {
        columns = extractOracleColumns(row);
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
     query.on('close', function() {
        //console.log("stream 'close' event");
        // The underlying ResultSet has been closed, so the connection can now
        // be closed, if desired.  Note: do not close connections on 'end'.
        //resolve(rowcount);
        ;
      });
    //});

    //const numrows = await consumeStream;
    //console.log('Rows selected: ' + numrows);
    //client.query(query);
  },
  async getVersion(client) {
    //const { rows } = await this.query(client, "SELECT banner as version FROM v$version WHERE banner LIKE 'Oracle%'");
    const { rows } = await this.query(client, "SELECT version as \"version\" FROM v$instance");
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

    query.on('metadata', row => {
      console.log('readQuery metadata', row);
      if (!wasHeader) {
        columns = extractOracleColumns(row);
        if (columns && columns.length > 0) {
        pass.write({
          __isStreamHeader: true,
          ...(structure || { columns }),
        });
        }
        wasHeader = true;
      }

      pass.write(zipDataRow(row, columns));
    });

    query.on('data', row => {
      console.log('readQuery data', row);
      pass.write(zipDataRow(row, columns));
    });

    query.on('end', () => {
      pass.end();
    });

    query.on('error', error => {
      console.error(error);
      pass.end();
    });

    //client.query(query);

    return pass;
  },
  async writeTable(pool, name, options) {
    // @ts-ignore
    return createBulkInsertStreamBase(this, stream, pool, name, options);
  },
  async listDatabases(client) {
    const { rows } = await this.query(client, 'SELECT instance_name AS \"name\" FROM v$instance');
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

drivers.initialize = (dbgateEnv) => {
  if (dbgateEnv.nativeModules && dbgateEnv.nativeModules.oracledb) {
    oracledb = dbgateEnv.nativeModules.oracledb();
  }
};

module.exports = drivers;
