"use strict";

const Path = require('path');
const Fs = require('fs');
const stripJsonComments = require('strip-json-comments');
const promisify = require('util').promisify;

let _tablePrefix = '';

// A little helper that goes with me everywhere

/**
 * @param {String} path
 * @param {Boolean} stripComments
 * @param {function(error: Error, result: *?)}callback
 */
const readJsonFile = (path, stripComments, callback) => {

    if (callback === undefined && typeof stripComments === 'function') {
        callback = /**@type {function(error: Error, result: *?)}*/stripComments;
        stripComments = false;
    }

    Fs.readFile(path, 'utf8', (err, json) => {
        if (err) {
            callback(err);
        } else {
            let data = null;

            try {
                if (stripComments) {
                    json = stripJsonComments(json);
                }
                data = JSON.parse(json);
            } catch (e) {
                err = e;
            }

            callback(err, data);
        }

    });

};

/**
 * @type {function(path: String, stripComments: Boolean):Promise<*>}
 */
const readJsonFilePromisified = promisify(readJsonFile);

/**
 * Description of a table column
 * @typedef {{name: String, type: String, length: Number?, text_type: String?, precision: Number?, scale: Number?, default: *?, raw_default: *?, unique: Boolean?, primary_key: Boolean?, nullable: Boolean?, enum_values: Array<String>?, collate: String?}} TableColumnDescription
 */

/**
 * Description of a table index
 * @typedef {{name: String?, columns: <Array<String>|String>}} TableIndexDescription
 */

/**
 * Description of a table foreign key
 * @typedef {{columns: <Array<String>|String>, foreign_table: String, foreign_columns: <Array<String>|String>, on_delete: String?, on_update: String?}} TableForeignKeyDescription
 */

/**
 * Description of a full table
 * @typedef {{columns: Array<TableColumnDescription>, indexes: Array<TableIndexDescription>?, foreign_keys: Array<TableForeignKeyDescription>?, primary_key: <Array<String>|String>?, engine: String?, charset: String?, collate: String?, timestamps: Boolean?}} TableDescription
 */
/** */

const defaultErrorHandler = ignoreExistsError => {
    if (ignoreExistsError) {
        return err => {
            if (/(\b|_)(exists|duplicate|dup)(\b|_)/i.test(err.code)) {
                console.log('Ignoring error', err);
                return;
            }

            throw err;
        };
    } else {
        return err => { throw err; };
    }
};

/** */
module.exports = class KnexSchemaBuilder {
    // noinspection JSUnusedGlobalSymbols
    /**
     * Sets a generic table prefix for all table creations
     * @param {string} prefix - A prefix for tables
     * @param {function(error:?, prefix:string)?} callback - optional callback
     * @returns {Promise<string>}
     */
    static async setTablePrefix(prefix, callback) {
        _tablePrefix = prefix == null ? '' : (prefix + '');
        let ret = _tablePrefix;

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, ret));
        }

        return ret;
    }

    /**
     * Determine if a schema upgrade is required
     * @param {Object} db A knex instance
     * @param {string} schemaPath Path to where the schema files reside
     * @param {function(error:?, isUpgradeNeeded:boolean?)?} callback - optional callback
     * @returns {Promise<boolean>}
     */
    static async isUpgradeNeeded(db, schemaPath, callback) {
        let ret = false;
        try {
            let dbVer = await KnexSchemaBuilder.getCurrentDbVersion(db);
            let latestVersion = await KnexSchemaBuilder.getLatestDbVersion(schemaPath);
            ret = dbVer < latestVersion;
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, ret));
        }

        return ret;
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Determine if a full schema installation is required
     * @param {Object} db A knex instance
     * @param {string} schemaPath Path to where the schema files reside
     * @param {function(error:?, isInstallNeeded:boolean?)?} callback - optional callback
     * @returns {Promise<boolean>}
     */
    static async isInstallNeeded(db, schemaPath, callback) {
        let ret = true;

        try {
            let version = await KnexSchemaBuilder.getCurrentDbVersion(db);
            ret = version === null;
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, ret));
        }

        return ret;
    }

    /**
     * Kick off the installation routine.
     * @param {Object} db A knex instance
     * @param {string} schemaPath Path to where the schema files reside
     * @param {boolean} [ignoreExistsError=false] Ignore "exists" error for table/index creation, can be used to continue a failed install
     * @param {function(error:?, version:number)?} callback - optional callback
     * @returns {Promise<number>}
     */
    static async install(db, schemaPath, ignoreExistsError, callback) {
        if (callback === undefined && typeof ignoreExistsError === 'function') {
            callback = ignoreExistsError;
            ignoreExistsError = false;
        }

        let version;

        try {
            let dbTables = {}, dbRawQueries = [];

            version = await KnexSchemaBuilder.getLatestDbVersion(schemaPath);
            let schema = await readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true);

            if (schema['schema'] && !Array.isArray(schema['schema']['columns'])) {
                dbTables = schema['schema'];
                dbRawQueries = schema['raw'] || [];
            } else {
                dbTables = schema;
            }

            for (let tableName of Object.keys(dbTables)) {
                await KnexSchemaBuilder.createTable(db, tableName, dbTables[tableName])
                    .catch(defaultErrorHandler(ignoreExistsError));
            }

            // Execute raw queries
            for (let rawQuery of dbRawQueries) {
                if (Array.isArray(rawQuery) && typeof (rawQuery[0]) === 'string') {
                    rawQuery = rawQuery.join('\n');
                }

                if (rawQuery && typeof (rawQuery) === 'string') {
                    await db.raw(rawQuery.replace(/{table_prefix}/g, _tablePrefix))
                        .catch(defaultErrorHandler(ignoreExistsError));
                }
            }

            for (let tableName of Object.keys(dbTables)) {
                await KnexSchemaBuilder.createTableIndexes(db, tableName, dbTables[tableName], ignoreExistsError)
                    .catch(err => {
                        let error = new Error('Failed to create indexes for table ' + tableName + '\n' + err.toString());
                        err.error = err;
                        throw error;
                    });
            }

            for (let tableName of Object.keys(dbTables)) {
                await KnexSchemaBuilder.createTableForeignKeys(db, tableName, dbTables[tableName], ignoreExistsError)
                    .catch(err => {
                        let error = new Error('Failed to create foreign keys for table ' + tableName + '\n' + err.toString());
                        err.error = err;
                        throw error;
                    });
            }

            await KnexSchemaBuilder.setCurrentDbVersion(db, version);
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            return setImmediate(() => callback(null, version));
        }
    }

    /**
     * Kick off the upgrade routine.
     * This will check the current db schema version against the latest, and run the appropriate upgrade routines.
     * If it detects that the db is not even installed (no version specified), then the returned error will be 'empty-database' (String)
     * @param {Object} db A knex instance
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?, version: number)?} callback - optional callback
     * @returns {Promise<number>}
     */
    static async upgrade(db, schemaPath, callback) {
        let saveVersion;

        try {
            let schemaJson = await readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true);

            if (schemaJson['schema'] && !Array.isArray(schemaJson['schema']['columns'])) {
                schemaJson = schemaJson['schema'];
            }
            let schema = schemaJson;

            let originalVersion, currentVersion;
            originalVersion = currentVersion = saveVersion = await KnexSchemaBuilder.getCurrentDbVersion(db);
            let latestVersion = await KnexSchemaBuilder.getLatestDbVersion(schemaPath);

            try {
                try {
                    // While the current version hasn't yet reached the latest version
                    while (currentVersion < latestVersion) {
                        // Load the correct upgrade.####.json file, then perform the relevant actions.

                        let upgradeSchema;

                        try {
                            upgradeSchema = await readJsonFilePromisified(
                                Path.join(schemaPath, 'upgrade.' + (currentVersion + 1) + '.json'), true);
                        } catch (err) {
                            if (err.code === 'ENOENT') {
                                console.log('Upgrade schema for version ' + (currentVersion + 1) +
                                    ' (upgrade.' + (currentVersion + 1) + '.json)' +
                                    ' not found, skipping...');
                                currentVersion++;
                                continue;
                            }

                            if (err instanceof SyntaxError) {
                                console.log('Upgrade schema for version ' + (currentVersion + 1) +
                                    ' (upgrade.' + (currentVersion + 1) + '.json)' +
                                    ' contains invalid JSON. Please correct it and try again.');
                            }

                            // noinspection ExceptionCaughtLocallyJS
                            throw err;
                        }

                        for (let action of upgradeSchema) {
                            const softThrow = err => {
                                if (err && action['ignore_errors']) {
                                    console.log('Ignoring error', err);
                                    err = null;
                                } else if (err) {
                                    throw err;
                                }
                            };

                            if (action['min_version'] && action['min_version'] >= originalVersion) {
                                continue;
                            }

                            if (action['max_version'] && action['max_version'] <= originalVersion) {
                                continue;
                            }

                            switch (action['action']) {

                                case 'execute':
                                    let rawQuery = action['query'];
                                    if (Array.isArray(rawQuery) && typeof (rawQuery[0]) === 'string') {
                                        rawQuery = rawQuery.join('\n');
                                    }

                                    await db.raw(rawQuery.replace(/{table_prefix}/g, _tablePrefix)).catch(softThrow);
                                    break;

                                case 'createTable':
                                    if (schema[action['table']]) {
                                        await KnexSchemaBuilder.createTable(db, action['table'], schema[action['table']]).catch(softThrow);
                                    } else {
                                        console.log(
                                            'Unknown table named `' + action['table'] + '`. Failing...');
                                        softThrow('unknown-table');
                                    }
                                    break;

                                case 'createTableIndexes':
                                    if (schema[action['table']]) {
                                        await KnexSchemaBuilder.createTableIndexes(db, action['table'], schema[action['table']]).catch(softThrow);
                                    } else {
                                        console.log(
                                            'Unknown table named `' + action['table'] + '`. Failing...');
                                        softThrow('unknown-table');
                                    }
                                    break;

                                case 'createTableForeignKeys':
                                    if (schema[action['table']]) {
                                        await KnexSchemaBuilder.createTableForeignKeys(db, action['table'], schema[action['table']]).catch(softThrow);
                                    } else {
                                        console.log(
                                            'Unknown table named `' + action['table'] + '`. Failing...');
                                        softThrow('unknown-table');
                                    }
                                    break;

                                case 'addColumn':
                                    if (schema[action['table']]) {
                                        const columns = schema[action['table']]['columns'];
                                        const column = columns.find(item => item['name'] === action['column']);
                                        const prevColumn = columns[columns.indexOf(column) - 1];

                                        if (column) {
                                            await db.schema
                                                .table(_tablePrefix + action['table'], table => {
                                                    let pendingCol = KnexSchemaBuilder.createColumn(db, table, column);
                                                    if (prevColumn)
                                                        pendingCol.after(prevColumn['name']);
                                                    else pendingCol.first();
                                                })
                                                .catch(err => {
                                                    if (err.code === 'ER_BAD_FIELD_ERROR') {
                                                        return db.schema.table(_tablePrefix + action['table'], table => {
                                                            KnexSchemaBuilder.createColumn(db, table, column);
                                                        });
                                                    } else {
                                                        throw err;
                                                    }
                                                })
                                                .catch(softThrow);
                                        } else {
                                            console.log(
                                                'Unknown column named `' + action['column'] + '`. Failing...');
                                            softThrow('unknown-column');
                                        }
                                    } else {
                                        console.log(
                                            'Unknown table named `' + action['table'] + '`. Failing...');
                                        softThrow('unknown-table');
                                    }
                                    break;

                                case 'alterColumn':
                                    if (schema[action['table']]) {
                                        const columns = schema[action['table']]['columns'];
                                        const column = columns.find(item => item['name'] === action['column']);
                                        const prevColumn = columns[columns.indexOf(column) - 1];

                                        if (column) {
                                            await db.schema
                                                .table(_tablePrefix + action['table'], table => {
                                                    let pendingCol = KnexSchemaBuilder.createColumn(db, table, column).alter();
                                                    if (prevColumn)
                                                        pendingCol.after(prevColumn['name']);
                                                    else pendingCol.first();
                                                })
                                                .catch(err => {
                                                    if (err.code === 'ER_BAD_FIELD_ERROR') {
                                                        return db.schema.table(_tablePrefix + action['table'], table => {
                                                            KnexSchemaBuilder.createColumn(db, table, column).alter();
                                                        });
                                                    } else {
                                                        throw err;
                                                    }
                                                })
                                                .catch(softThrow);
                                        } else {
                                            console.log(
                                                'Unknown column named `' + action['column'] + '`. Failing...');
                                            softThrow('unknown-column');
                                        }
                                    } else {
                                        console.log(
                                            'Unknown table named `' + action['table'] + '`. Failing...');
                                        softThrow('unknown-table');
                                    }
                                    break;

                                case 'renameColumn':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            // noinspection JSUnresolvedFunction
                                            table.renameColumn(action['from'], action['to']);
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'createIndex':
                                    await KnexSchemaBuilder.createIndex(db, action['table'], action).catch(softThrow);
                                    break;

                                case 'createForeign':
                                    await KnexSchemaBuilder.createForeign(db, action['table'], action).catch(softThrow);
                                    break;

                                case 'dropColumn':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            // noinspection JSUnresolvedFunction
                                            table.dropColumn(action['column']);
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'dropTable':
                                    // noinspection JSUnresolvedFunction
                                    await db.schema.dropTableIfExists(_tablePrefix + action['table'])
                                        .catch(softThrow);
                                    break;

                                case 'dropPrimary':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            // noinspection JSUnresolvedFunction
                                            table.dropPrimary();
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'dropIndex':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            if (action['name']) {
                                                // noinspection JSUnresolvedFunction
                                                table.dropIndex(null, action['name']);
                                            } else {
                                                // noinspection JSUnresolvedFunction
                                                table.dropIndex(action['column']);
                                            }
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'dropForeign':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            if (action['name']) {
                                                // noinspection JSUnresolvedFunction
                                                table.dropForeign(null, action['name']);
                                            } else {
                                                // noinspection JSUnresolvedFunction
                                                table.dropForeign(action['column']);
                                            }
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'dropUnique':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            if (action['name']) {
                                                // noinspection JSUnresolvedFunction
                                                table.dropUnique(null, action['name']);
                                            } else {
                                                // noinspection JSUnresolvedFunction
                                                table.dropUnique(action['column']);
                                            }
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'addTimestamps':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            // noinspection JSValidateTypes
                                            table.timestamps();
                                        })
                                        .catch(softThrow);
                                    break;

                                case 'dropTimestamps':
                                    await db.schema
                                        .table(_tablePrefix + action['table'], table => {
                                            // noinspection JSUnresolvedFunction
                                            table.dropTimestamps();
                                        })
                                        .catch(softThrow);
                                    break;

                                default:
                                    console.log(
                                        'Unknown upgrade action `' + action['action'] + '`. Failing...');
                                    softThrow('unknown-action');
                                    break;
                            }
                        }

                        currentVersion++;
                    }
                } finally {
                    saveVersion = currentVersion;
                }

                saveVersion = latestVersion;
            } finally {
                if (saveVersion !== originalVersion) {
                    await KnexSchemaBuilder.setCurrentDbVersion(db, saveVersion);
                }
            }
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err, saveVersion));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            return setImmediate(() => callback(null, saveVersion));
        }

        return saveVersion;
    }

    /**
     * Retrieves the schema version of the current db
     * @param {Object} db A knex instance
     * @param {function(error:?, version:number|null)?} callback - optional callback
     * @returns {Promise<number|null>}
     */
    static async getCurrentDbVersion(db, callback) {
        
        let version = null;
        
        try {
            await KnexSchemaBuilder.ensureSchemaGlobalsExist(db);

            let row = await db.select('value')
                .from('schema_globals')
                .where('key', _tablePrefix + 'db_version')
                .limit(1)
                .first();

            if (row)
                version = parseFloat(row['value']);
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }

            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, version));
        }

        return version;
    }

    /**
     * Sets the schema version of the current db
     * @param {Object} db A knex instance
     * @param {number} version A version, as a whole number
     * @param {function(error:?, version:number)?} callback - optional callback
     * @returns {Promise<number>}
     */
    static async setCurrentDbVersion(db, version, callback) {
        try {
            let currentDbVersion = await KnexSchemaBuilder.getCurrentDbVersion(db);

            if (currentDbVersion == null) {
                // noinspection JSUnresolvedFunction
                await db
                    .insert({'value': version, 'key': _tablePrefix + 'db_version'})
                    .into('schema_globals');

            } else {
                // noinspection JSUnresolvedFunction
                await db
                    .table('schema_globals')
                    .update('value', version)
                    .where('key', _tablePrefix + 'db_version');
            }
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, version));
        }

        return version;
    }

    /**
     * Retrieves the latest schema version which is specified in version.json
     * @param {string} schemaPath Path to where the schema files reside
     * @param {function(error:?, version:number?)?} callback - optional callback
     * @returns {Promise<number>}
     */
    static async getLatestDbVersion(schemaPath, callback) {
        let ret = null;

        try {
            let data = await readJsonFilePromisified(Path.join(schemaPath, 'version.json'), true);

            if (data)
                ret = data['version'];
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, ret));
        }

        return ret;
    }

    /**
     * Manually create a column in a table
     * This does not create the indexes or foreign keys - they are created in different calls.
     * @param {Object} db A knex instance
     * @param {Object} table A knex table instance (inside a "table" call)
     * @param {TableColumnDescription} columnData The column data
     * @returns {Object} knex column
     */
    static createColumn(db, table, columnData) {

        const name = columnData['name'];
        if (!name) {
            console.log('The column ' + (JSON.stringify(columnData)) + ' is missing a name!');
            throw 'column-missing-name';
        }
        let type = columnData['type'];
        if (!type) {
            console.log('The column ' + (name ? name : JSON.stringify(columnData)) + ' is missing a type!');
            throw 'column-missing-type';
        }

        const unsigned = type.startsWith('unsigned ');
        if (unsigned) {
            type = type.substr(9);
        }

        let column;
        if (type[0] === ':') {
            // noinspection JSUnresolvedFunction
            column = table.specificType(name, type.substr(1));
        } else if (type === 'text') {
            column = table.text(name, columnData['text_type']);
        } else if (type === 'string' || type === 'varchar' || type === 'char') {
            column = table[type](name, columnData['length']);
        } else if (type === 'float' || type === 'double' || type === 'decimal') {
            column = table[type](name, columnData['precision'], columnData['scale']);
        } else if (type === 'timestamp' || type === 'timestamptz') {
            // noinspection JSValidateTypes
            column = table.timestamp(name, type !== 'timestamptz');
        } else if (type === 'enu' || type === 'enum') {
            // noinspection JSUnresolvedFunction
            column = table.enu(name, columnData['enum_values']);
        } else if (type === 'json' || type === 'jsonb') {
            column = table.json(name, type === 'jsonb');
        } else {
            column = table[type](name);
        }

        if (unsigned) {
            // noinspection JSUnresolvedFunction
            column.unsigned();
        }

        if (columnData['raw_default'] !== undefined) {
            // noinspection JSUnresolvedFunction
            column.defaultTo(db.raw(columnData['raw_default']));
        } else if (columnData['default'] !== undefined) {
            // noinspection JSUnresolvedFunction
            column.defaultTo(columnData['default']);
        }

        if (columnData['unique']) {
            // noinspection JSValidateTypes
            column.unique();
        }

        if (columnData['primary_key']) {
            // noinspection JSUnresolvedFunction
            column.primary();
        }

        if (columnData['unsigned']) {
            // noinspection JSUnresolvedFunction
            column.unsigned();
        }

        if (columnData['nullable'] != null && !columnData['nullable']) {
            // noinspection JSUnresolvedFunction
            column.notNullable();
        }

        if (typeof columnData['collate'] === 'string') {
            // noinspection JSValidateTypes
            column.collate(columnData['collate']);
        }

        return column;
    };

    /**
     * Manually create the table from a table description object.
     * This does not create the indexes or foreign keys - they are created in different calls.
     * @param {Object} db A knex instance
     * @param {string} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>}
     */
    static async createTable(db, tableName, tableData, callback) {
        try {
            // noinspection JSCheckFunctionSignatures
            const table = db.schema.createTable(_tablePrefix + tableName, table => {

                const columns = tableData['columns'];
                if (columns) {
                    for (const column of columns) {
                        KnexSchemaBuilder.createColumn(db, table, column);
                    }
                }

                const primaryKey = tableData['primary_key'];
                if (primaryKey) {
                    if (primaryKey instanceof Array) {
                        // noinspection JSUnresolvedFunction
                        table.primary(tableData['primary_key']);
                    } else {
                        // noinspection JSUnresolvedFunction
                        table.primary([primaryKey]);
                    }
                }

                if (tableData['timestamps']) {
                    // noinspection JSValidateTypes
                    table.timestamps();
                }

            });

            for (const func of ['engine', 'charset', 'collate']) {
                if (tableData[func]) {
                    table[func](tableData[func]);
                }
            }

            await table;
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(err));
        }
    }

    /**
     * Manually create the indexes from a table description object.
     * @param {Object} db A knex instance
     * @param {string} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {boolean} [ignoreExistsError=false] Ignore "exists" error for single index creation, can be used to continue a failed install
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>}
     */
    static async createTableIndexes(db, tableName, tableData, ignoreExistsError, callback) {
        if (callback === undefined && typeof ignoreExistsError === 'function') {
            callback = ignoreExistsError;
            ignoreExistsError = false;
        }

        try {
            await db.schema
                .table(_tablePrefix + tableName, table => {
                    for (const index of (tableData['indexes'] || [])) {
                        KnexSchemaBuilder._createIndexInner(table, index);
                    }
                })
                .catch(defaultErrorHandler(ignoreExistsError))
                .then(() => undefined);
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null));
        }
    }

    /**
     * Manually create an index
     * @param {Object} db A knex instance
     * @param {string} tableName The name of the table to create
     * @param {TableIndexDescription} indexData The index data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>}
     */
    static async createIndex(db, tableName, indexData, callback) {
        try {
            await db.schema.table(_tablePrefix + tableName, table => {
                KnexSchemaBuilder._createIndexInner(table, indexData);
            });
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null));
        }
    }

    /**
     * Inner implementation for index creation
     * @private
     * @param {Object} table A knex table closure
     * @param {TableIndexDescription} indexData The index data
     */
    static _createIndexInner(table, indexData) {
        let columns = indexData['columns'];
        columns = (columns && !(columns instanceof Array)) ? [columns] : columns;
        if (indexData['unique']) {
            // noinspection JSValidateTypes
            table.unique(columns, indexData['name']);
        } else {
            table.index(columns, indexData['name']);
        }
    }

    /**
     * Manually create the foreign keys from a table description object.
     * @param {Object} db A knex instance
     * @param {string} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {boolean} [ignoreExistsError=false] Ignore "exists" error for single key creation, can be used to continue a failed install
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>}
     */
    static async createTableForeignKeys(db, tableName, tableData, ignoreExistsError, callback) {
        if (callback === undefined && typeof ignoreExistsError === 'function') {
            callback = ignoreExistsError;
            ignoreExistsError = false;
        }

        try {
            await db.schema
                .table(_tablePrefix + tableName, table => {
                    for (const foreignKeyData of (tableData['foreign_keys'] || [])) {
                        KnexSchemaBuilder._createForeignInner(table, foreignKeyData);
                    }
                })
                .catch(defaultErrorHandler(ignoreExistsError));
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        if (typeof callback === 'function') {
            setImmediate(() => callback(null));
        }
    }

    /**
     * Manually create an foreign key
     * @param {Object} db A knex instance
     * @param {string} tableName The name of the table to create
     * @param {TableForeignKeyDescription} foreignKey The foreign key data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>}
     */
    static createForeign(db, tableName, foreignKey, callback) {

        const promise = db.schema
            .table(_tablePrefix + tableName, table => {
                KnexSchemaBuilder._createForeignInner(table, foreignKey);
            })
            .then(() => undefined);

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(() => {callback(null);});
        }

        return promise;
    }

    /**
     * Inner implementation for foreign key creation
     * @private
     * @param {Object} table A knex table closure
     * @param {TableForeignKeyDescription} foreignKey The foreign key data
     */
    static _createForeignInner(table, foreignKey) {
        let columns = foreignKey['columns'],
            foreigns = foreignKey['foreign_columns'];
        columns = (columns && !(columns instanceof Array)) ? [columns] : columns;
        foreigns = (foreigns && !(foreigns instanceof Array)) ? [foreigns] : foreigns;

        // noinspection JSUnresolvedFunction
        const foreign = table.foreign(columns)
            .references(foreigns)
            .inTable(_tablePrefix + foreignKey['foreign_table']);

        if (foreignKey['on_update']) {
            // noinspection JSUnresolvedFunction
            foreign.onUpdate(foreignKey['on_update']);
        }

        if (foreignKey['on_delete']) {
            // noinspection JSUnresolvedFunction
            foreign.onDelete(foreignKey['on_delete']);
        }
    }

    /**
     * Ensures that the schema_globals exists.
     * @param {Object} db A knex instance
     * @param {function(error:?, created:boolean)?} callback - optional callback
     * @returns {Promise<boolean>} - was the schema_globals created just now?
     */
    static async ensureSchemaGlobalsExist(db, callback) {
        try {
            // noinspection JSUnresolvedFunction
            let exists = await db.schema.hasTable('schema_globals');
            if (exists) {
                if (typeof callback === 'function') {
                    setImmediate(() => callback(null, false));
                }
                return false;
            }

            // noinspection JSCheckFunctionSignatures
            await db.schema.createTable('schema_globals', table => {
                // noinspection JSUnresolvedFunction
                table.string('key', 64).notNullable().primary();

                // noinspection JSUnresolvedFunction
                table.string('value', 255);
            });

            if (typeof callback === 'function') {
                setImmediate(() => callback(null, true));
            }
        } catch (err) {
            if (typeof callback === 'function') {
                return setImmediate(() => callback(err));
            }
            throw err;
        }

        return true;
    }

    // noinspection JSUnusedGlobalSymbols
    static get mysqlBackup() {
        return require('./backup/mysql');
    }
};
