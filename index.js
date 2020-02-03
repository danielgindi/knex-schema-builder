"use strict";

const Path = require('path');
const Fs = require('fs');
const stripJsonComments = require('strip-json-comments');
const promisify = require('util.promisify');
const PromiseHelper = require('./util/promises');

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
        }
        else {
            let data = null;

            try {
                if (stripComments) {
                    json = stripJsonComments(json);
                }
                data = JSON.parse(json);
            }
            catch (e) {
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
module.exports = class KnexSchemaBuilder {
    // noinspection JSUnusedGlobalSymbols
    /**
     * Sets a generic table prefix for all table creations
     * @param {String} prefix - A prefix for tables
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<Boolean>|*}
     */
    static setTablePrefix(prefix, callback) {

        _tablePrefix = prefix == null ? '' : (prefix + '');

        if (typeof callback === 'function') {
            process.nextTick(() => {
                callback(null, _tablePrefix);
            });
        }

        return new Promise((resolve/*, reject*/) => {
            resolve(_tablePrefix);
        });
    }

    /**
     * Determine if a schema upgrade is required
     * @param {Object} db A knex instance
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?, isUpgradeNeeded:Boolean?)?} callback - optional callback
     * @returns {Promise<Boolean>|*}
     */
    static isUpgradeNeeded(db, schemaPath, callback) {

        const promise = KnexSchemaBuilder.getCurrentDbVersion(db)
            .then(dbVer =>
                KnexSchemaBuilder.getLatestDbVersion(schemaPath)
                    .then(latestVersion => dbVer < latestVersion));

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Determine if a full schema installation is required
     * @param {Object} db A knex instance
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?, isInstallNeeded:Boolean?)?} callback - optional callback
     * @returns {Promise<Boolean>|*}
     */
    static isInstallNeeded(db, schemaPath, callback) {

        const promise = KnexSchemaBuilder.getCurrentDbVersion(db)
            .then(version => version == null);

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    /**
     * Kick off the installation routine.
     * @param {Object} db A knex instance
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<Number>|*}
     */
    static install(db, schemaPath, callback) {

        let dbTables = {}, dbRawQueries = [];

        const promise = readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true)
            .then(schema => {

                if (schema['schema'] && !Array.isArray(schema['schema']['columns'])) {
                    dbTables = schema['schema'];
                    dbRawQueries = schema['raw'] || [];
                }
                else {
                    dbTables = schema;
                }
            })
            .then(() => {
                // Execute schema building
                return Promise.all(
                    Object.keys(dbTables)
                          .map(tableName => KnexSchemaBuilder.createTable(db, tableName, dbTables[tableName]))
                );
            })
            .then(() => {
                // Execute raw queries

                return PromiseHelper.serial(dbRawQueries.map(rawQuery => () => {
                    if (Array.isArray(rawQuery) && typeof (rawQuery[0]) === 'string') {
                        rawQuery = rawQuery.join('\n');
                    }

                    if (rawQuery && typeof (rawQuery) === 'string') {
                        return db.raw(rawQuery.replace(/{table_prefix}/g, _tablePrefix));
                    }
                }));
            })
            .then(() =>
                PromiseHelper.serial(
                    Object.keys(dbTables)
                          .map(tableName =>
                              () => KnexSchemaBuilder.createTableIndexes(db, tableName,
                                  dbTables[tableName])
                                  .catch(err => {

                                      err = 'Failed to create indexes for table ' + tableName + '\n' + err.toString();
                                      throw err;

                                  })
                          )
                )
            )
            .then(() =>
                PromiseHelper.serial(
                    Object.keys(dbTables)
                          .map(tableName =>
                              () => KnexSchemaBuilder.createTableForeignKeys(db, tableName,
                                  dbTables[tableName])
                                  .catch(err => {

                                      err = 'Failed to create foreign keys for table ' + tableName + '\n' + err.toString();
                                      throw err;

                                  })
                          )
                )
            )
            .then(() =>
                KnexSchemaBuilder.getLatestDbVersion(schemaPath)
                    .then(version => KnexSchemaBuilder.setCurrentDbVersion(db, version))
            );

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    /**
     * Kick off the upgrade routine.
     * This will check the current db schema version against the latest, and run the appropriate upgrade routines.
     * If it detects that the db is not even installed (no version specified), then the returned error will be 'empty-database' (String)
     * @param {Object} db A knex instance
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
     */
    static upgrade(db, schemaPath, callback) {

        let schema, currentVersion, latestVersion, originalVersion, saveVersion;

        const promise = readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true)
            .then(schemaJson => {
                if (schemaJson['schema'] && !Array.isArray(schemaJson['schema']['columns'])) {
                    schemaJson = schemaJson['schema'];
                }
                schema = schemaJson;
            })
            .then(() => KnexSchemaBuilder.getCurrentDbVersion(db)
                .then(version => {
                    originalVersion = currentVersion = version;

                    return KnexSchemaBuilder.getLatestDbVersion(schemaPath);
                })
                .then(version => {
                    latestVersion = version;
                })
            )
            .then(function () {

                // While the current version hasn't yet reached the latest version
                return PromiseHelper.while(
                    () => currentVersion < latestVersion,
                    () => {

                        // Load the correct upgrade.####.json file, then perform the relevant actions.

                        let hasUpgradeSchema = false;
                        let upgradeSchema;

                        return readJsonFilePromisified(Path.join(schemaPath, 'upgrade.' + (currentVersion + 1) + '.json'),
                            true)
                            .then(schema => {
                                upgradeSchema = schema;
                                hasUpgradeSchema = true;
                            })
                            .then(() => PromiseHelper.serial(upgradeSchema.map(action => () => {
                                const softThrow = err => {
                                    if (err && action['ignore_errors']) {
                                        console.log('Ignoring error', err);
                                        err = null;
                                    }
                                    else if (err) {
                                        throw err;
                                    }
                                };

                                if (action['min_version'] && action['min_version'] >= originalVersion) {
                                    return;
                                }

                                if (action['max_version'] && action['max_version'] <= originalVersion) {
                                    return;
                                }

                                switch (action['action']) {

                                    case 'execute':
                                        let rawQuery = action['query'];
                                        if (Array.isArray(rawQuery) && typeof (rawQuery[0]) === 'string') {
                                            rawQuery = rawQuery.join('\n');
                                        }

                                        return db.raw(rawQuery.replace(/{table_prefix}/g, _tablePrefix))
                                                 .catch(softThrow);

                                    case 'createTable':
                                        if (schema[action['table']]) {
                                            return KnexSchemaBuilder.createTable(db, action['table'], schema[action['table']])
                                                .catch(softThrow);
                                        }
                                        else {
                                            console.log(
                                                'Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'createTableIndexes':
                                        if (schema[action['table']]) {
                                            return KnexSchemaBuilder.createTableIndexes(db, action['table'],
                                                schema[action['table']])
                                                .catch(softThrow);
                                        }
                                        else {
                                            console.log(
                                                'Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'createTableForeignKeys':
                                        if (schema[action['table']]) {
                                            return KnexSchemaBuilder.createTableForeignKeys(db, action['table'],
                                                schema[action['table']])
                                                .catch(softThrow);
                                        }
                                        else {
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
                                                return db.schema
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
                                            }
                                            else {
                                                console.log(
                                                    'Unknown column named `' + action['column'] + '`. Failing...');
                                                softThrow('unknown-column');
                                            }
                                        }
                                        else {
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
                                                return db.schema
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
                                            }
                                            else {
                                                console.log(
                                                    'Unknown column named `' + action['column'] + '`. Failing...');
                                                softThrow('unknown-column');
                                            }
                                        }
                                        else {
                                            console.log(
                                                'Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'renameColumn':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {
                                                     // noinspection JSUnresolvedFunction
                                                     table.renameColumn(action['from'], action['to']);
                                                 })
                                                 .catch(softThrow);

                                    case 'createIndex':
                                        return KnexSchemaBuilder.createIndex(db, action['table'], action).catch(softThrow);

                                    case 'createForeign':
                                        return KnexSchemaBuilder.createForeign(db, action['table'], action).catch(softThrow);

                                    case 'dropColumn':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {
                                                     // noinspection JSUnresolvedFunction
                                                     table.dropColumn(action['column']);
                                                 })
                                                 .catch(softThrow);

                                    case 'dropTable':
                                        // noinspection JSUnresolvedFunction
                                        return db.schema.dropTableIfExists(_tablePrefix + action['table'])
                                                 .catch(softThrow);

                                    case 'dropPrimary':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {
                                                     // noinspection JSUnresolvedFunction
                                                     table.dropPrimary();
                                                 })
                                                 .catch(softThrow);

                                    case 'dropIndex':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {

                                                     if (action['name']) {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropIndex(null, action['name']);
                                                     }
                                                     else {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropIndex(action['column']);
                                                     }

                                                 })
                                                 .catch(softThrow);

                                    case 'dropForeign':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {

                                                     if (action['name']) {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropForeign(null, action['name']);
                                                     }
                                                     else {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropForeign(action['column']);
                                                     }

                                                 })
                                                 .catch(softThrow);

                                    case 'dropUnique':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {

                                                     if (action['name']) {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropUnique(null, action['name']);
                                                     }
                                                     else {
                                                         // noinspection JSUnresolvedFunction
                                                         table.dropUnique(action['column']);
                                                     }

                                                 })
                                                 .catch(softThrow);

                                    case 'addTimestamps':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {
                                                     // noinspection JSValidateTypes
                                                     table.timestamps();
                                                 })
                                                 .catch(softThrow);

                                    case 'dropTimestamps':
                                        return db.schema
                                                 .table(_tablePrefix + action['table'], table => {
                                                     // noinspection JSUnresolvedFunction
                                                     table.dropTimestamps();
                                                 })
                                                 .catch(softThrow);

                                    default:
                                        console.log(
                                            'Unknown upgrade action `' + action['action'] + '`. Failing...');
                                        softThrow('unknown-action');
                                        break;
                                }
                            })))
                            .then(() => {
                                currentVersion++;
                            })
                            .catch(err => {

                                if (!hasUpgradeSchema) {
                                    if (err instanceof SyntaxError) {
                                        console.log('Upgrade schema for version ' + (currentVersion + 1) +
                                            ' (upgrade.' + (currentVersion + 1) + '.json)' +
                                            ' contains invalid JSON. Please correct it and try again.');
                                    }
                                    else {
                                        console.log('Upgrade schema for version ' + (currentVersion + 1) +
                                            ' (upgrade.' + (currentVersion + 1) + '.json)' +
                                            ' not found, skipping...');
                                        err = false;
                                    }
                                }

                                if (err) {
                                    throw err;
                                }
                            });

                    })
                    .then(() => {
                        saveVersion = latestVersion;
                    })
                    .catch(err => {
                        saveVersion = currentVersion;

                        // Rethrow that error
                        throw err;
                    });

            })
            .then(() => KnexSchemaBuilder.setCurrentDbVersion(db, saveVersion))
            .then(() => undefined)
            .catch(err => {

                if (originalVersion === undefined) {
                    throw 'empty-database';
                }
                else {
                    // Save the point to which we've successfully made it...
                    return KnexSchemaBuilder.setCurrentDbVersion(db, saveVersion)
                        .then(() => {
                            // Rethrow that error
                            throw err;
                        });
                }

            });

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(() => {callback(null)});
        }

        return promise;
    }

    /**
     * Retrieves the schema version of the current db
     * @param {Object} db A knex instance
     * @param {function(error:?, version:Number)?} callback - optional callback
     * @returns {Promise<Number?>|*}
     */
    static getCurrentDbVersion(db, callback) {

        // noinspection JSUnresolvedFunction
        const promise = KnexSchemaBuilder.ensureSchemaGlobalsExist(db)
            .then(() => db.select('value')
                          .from('schema_globals')
                          .where('key', _tablePrefix + 'db_version')
                          .limit(1)
                          .then(rows => (rows && rows.length) ? parseFloat(rows[0]['value']) : null));

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    /**
     * Sets the schema version of the current db
     * @param {Object} db A knex instance
     * @param {Number} version A version, as a whole number
     * @param {function(error:?, version:Number)?} callback - optional callback
     * @returns {Promise<Number>|*}
     */
    static setCurrentDbVersion(db, version, callback) {

        const promise = KnexSchemaBuilder.getCurrentDbVersion(db)
            .then(currentDbVersion => {
                if (currentDbVersion == null) {
                    // noinspection JSUnresolvedFunction
                    return db
                        .insert({'value': version, 'key': _tablePrefix + 'db_version'})
                        .into('schema_globals')
                        .then(() => version);

                }
                else {
                    // noinspection JSUnresolvedFunction
                    return db
                        .table('schema_globals')
                        .update('value', version)
                        .where('key', _tablePrefix + 'db_version')
                        .then(() => version);
                }
            });

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    /**
     * Retrieves the latest schema version which is specified in version.json
     * @param {String} schemaPath Path to where the schema files reside
     * @param {function(error:?, version:Number?)?} callback - optional callback
     * @returns {Promise<Number>|*}
     */
    static getLatestDbVersion(schemaPath, callback) {

        const promise = readJsonFilePromisified(Path.join(schemaPath, 'version.json'), true)
            .then(data => {
                if (data) {
                    return data['version'];
                }

                return null;
            });

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
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
        }
        else if (type === 'text') {
            column = table.text(name, columnData['text_type']);
        }
        else if (type === 'string' || type === 'varchar' || type === 'char') {
            column = table[type](name, columnData['length']);
        }
        else if (type === 'float' || type === 'double' || type === 'decimal') {
            column = table[type](name, columnData['precision'], columnData['scale']);
        }
        else if (type === 'timestamp' || type === 'timestamptz') {
            // noinspection JSValidateTypes
            column = table.timestamp(name, type !== 'timestamptz');
        }
        else if (type === 'enu' || type === 'enum') {
            // noinspection JSUnresolvedFunction
            column = table.enu(name, columnData['enum_values']);
        }
        else if (type === 'json' || type === 'jsonb') {
            column = table.json(name, type === 'jsonb');
        }
        else {
            column = table[type](name);
        }

        if (unsigned) {
            // noinspection JSUnresolvedFunction
            column.unsigned();
        }

        if (columnData['raw_default'] !== undefined) {
            // noinspection JSUnresolvedFunction
            column.defaultTo(db.raw(columnData['raw_default']));
        }
        else if (columnData['default'] !== undefined) {
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
     * @param {String} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
     */
    static createTable(db, tableName, tableData, callback) {

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
                }
                else {
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

        const promise = table;

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    /**
     * Manually create the indexes from a table description object.
     * @param {Object} db A knex instance
     * @param {String} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
     */
    static createTableIndexes(db, tableName, tableData, callback) {

        const promise = db.schema
                          .table(_tablePrefix + tableName, table => {
                              for (const index of (tableData['indexes'] || [])) {
                                  KnexSchemaBuilder._createIndexInner(table, index);
                              }
                          })
                          .then(() => undefined);

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(() => {callback(null)});
        }

        return promise;
    }

    /**
     * Manually create an index
     * @param {Object} db A knex instance
     * @param {String} tableName The name of the table to create
     * @param {TableIndexDescription} indexData The index data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
     */
    static createIndex(db, tableName, indexData, callback) {

        const promise = db.schema
                          .table(_tablePrefix + tableName, table => {
                              KnexSchemaBuilder._createIndexInner(table, indexData);
                          })
                          .then(() => undefined);

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(() => {callback(null)});
        }

        return promise;
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
        }
        else {
            table.index(columns, indexData['name']);
        }
    }

    /**
     * Manually create the foreign keys from a table description object.
     * @param {Object} db A knex instance
     * @param {String} tableName The name of the table to create
     * @param {TableDescription} tableData The table data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
     */
    static createTableForeignKeys(db, tableName, tableData, callback) {

        const promise = db.schema
                          .table(_tablePrefix + tableName, table => {
                              for (const foreignKeyData of (tableData['foreign_keys'] || [])) {
                                  KnexSchemaBuilder._createForeignInner(table, foreignKeyData);
                              }
                          })
                          .then(() => undefined);

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(() => {callback(null)});
        }

        return promise;
    }

    /**
     * Manually create an foreign key
     * @param {Object} db A knex instance
     * @param {String} tableName The name of the table to create
     * @param {TableForeignKeyDescription} foreignKey The foreign key data
     * @param {function(error:?)?} callback - optional callback
     * @returns {Promise<void>|*}
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
                .then(() => {callback(null)});
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
     * @param {function(error:?, created:Boolean)?} callback - optional callback
     * @returns {Promise<Boolean>|*}
     */
    static ensureSchemaGlobalsExist(db, callback) {

        // noinspection JSUnresolvedFunction
        const promise = db.schema
                          .hasTable('schema_globals')
                          .then(exists => {
                              if (exists) {
                                  return false;
                              }
                              else {
                                  // noinspection JSCheckFunctionSignatures
                                  return db.schema
                                           .createTable('schema_globals', table => {
                                               // noinspection JSUnresolvedFunction
                                               table.string('key', 64).notNullable().primary();

                                               // noinspection JSUnresolvedFunction
                                               table.string('value', 255);
                                           })
                                           .then(() => true);
                              }
                          });

        if (typeof callback === 'function') {
            promise
                .catch(callback)
                .then(ret => {callback(null, ret)});
        }

        return promise;
    }

    // noinspection JSUnusedGlobalSymbols
    static get mysqlBackup() {
        return require('./backup/mysql');
    }
};
