"use strict";

var Path = require('path'),
    Fs = require('fs'),
    stripJsonComments = require('strip-json-comments'),
    knex = require('knex'),
    Bluebird = require('bluebird');

// A little helper that goes with me everywhere

var readJsonFile = function (path, stripComments, callback) {

    if (callback === undefined && typeof stripComments === 'function') {
        callback = stripComments;
        stripComments = false;
    }

    Fs.readFile(path, 'utf8', function (err, json) {
        if (err) {
            callback(err);
        } else {
            var data = null;
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

var readJsonFilePromisified = Bluebird.promisify(readJsonFile);

var promiseWhile = function (condition, action) {

    return new Bluebird(function (resolve, reject) {

        var loop = function () {

            if (!condition()) {
                return resolve();
            }

            return Bluebird.cast(action())
                .then(loop)
                .catch(reject);
        };

        if (setImmediate) {
            setImmediate(loop);
        } else {
            process.nextTick(loop);
        }

    });
};

var startsWith = function (string, prefix) {
    if (prefix === undefined || prefix === null) return false;
    if (typeof prefix !== 'string') prefix = prefix.toString();
    if (string.length < prefix.length) return false;
    return string.substr(0, prefix.length) === prefix;
};

/**
 * Description of a table column
 * @typedef {{name: String, type: String, length: Number?, text_type: String?, precision: Number?, scale: Number?, default: *?, raw_default: *?, unique: Boolean?, primary_key: Boolean?, nullable: Boolean?, enum_values: Array<String>?}} TableColumnDescription
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


/**
 * Manually create a column in a table
 * This does not create the indexes or foreign keys - they are created in different calls.
 * @param {Object} table A knex table instance (inside a "table" call)
 * @param {TableColumnDescription} columnData The column data
 * @returns {Object} knex column
 */
var createColumn = function (table, columnData) {

    var name = columnData['name'];
    if (!name) {
        console.log('The column ' + (JSON.stringify(columnData)) + ' is missing a name!');
        throw 'column-missing-name';
    }
    var type = columnData['type'];
    if (!type) {
        console.log('The column ' + (name ? name : JSON.stringify(columnData)) + ' is missing a type!');
        throw 'column-missing-type';
    }

    var unsigned = startsWith(type, 'unsigned ');
    if (unsigned) {
        type = type.substr(9);
    }

    var column;
    if (type[0] === ':') {
        column = table.specificType(name, type.substr(1));
    } else if (type === 'text') {
        column = table.text(name, columnData['text_type']);
    } else if (type === 'string' || type === 'varchar' || type === 'char') {
        column = table[type](name, columnData['length']);
    } else if (type === 'float' || type === 'double' || type === 'decimal') {
        column = table[type](name, columnData['precision'], columnData['scale']);
    } else if (type === 'timestamp' || type === 'timestamptz') {
        column = table.timestamp(name, type !== 'timestamptz');
    } else if (type === 'enu' || type === 'enum') {
        column = table.enu(name, columnData['enum_values']);
    } else if (type === 'json' || type === 'jsonb') {
        column = table.json(name, type === 'jsonb');
    } else {
        column = table[type](name);
    }

    if (unsigned) {
        column.unsigned();
    }

    if (columnData['raw_default'] !== undefined) {
        column.defaultTo(knex.raw(columnData['raw_default']));
    } else if (columnData['default'] !== undefined) {
        column.defaultTo(columnData['default']);
    }

    if (columnData['unique']) {
        column.unique();
    }

    if (columnData['primary_key']) {
        column.primary();
    }

    if (columnData['unsigned']) {
        column.unsigned();
    }

    if (columnData['nullable'] == false) {
        column.notNullable();
    }

    return column;
};

/**
 * Manually create the table from a table description object.
 * This does not create the indexes or foreign keys - they are created in different calls.
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableDescription} tableData The table data
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var createTable = function (db, tableName, tableData, callback) {

    var table = db.schema.createTable(tableName, function(table) {

        var columns = tableData['columns'];
        if (columns) {
            columns.forEach(function(column){
                createColumn(table, column);
            });
        }

        var primaryKey = tableData['primary_key'];
        if (primaryKey) {
            if (primaryKey instanceof Array) {
                table.primary(tableData['primary_key'])
            } else {
                table.primary([primaryKey]);
            }
        }

        if (tableData['timestamps']) {
            table.timestamps();
        }

    });

    ['engine', 'charset', 'collate'].forEach(function(func){
        if (tableData[func]) {
            table[func](tableData[func]);
        }
    });

    if (typeof callback === 'function') {
        table.asCallback(callback);
    }

    return table;
};

/**
 * Manually create the indexes from a table description object.
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableDescription} tableData The table data
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var createTableIndexes = function (db, tableName, tableData, callback) {

    var promise = db.schema
        .table(tableName, function(table) {

            (tableData['indexes'] || []).forEach(function (index) {
                createIndex_inner(table, index);
            });

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Manually create an index
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableIndexDescription} indexData The index data
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var createIndex = function (db, tableName, indexData, callback) {

    var promise = db.schema
        .table(tableName, function(table) {
            createIndex_inner(table, indexData);
        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Inner implementation for index creation
 * @param {Object} table A knex table closure
 * @param {TableIndexDescription} indexData The index data
 */
var createIndex_inner = function (table, indexData) {
    var columns = indexData['columns'];
    columns = (columns && !(columns instanceof Array)) ? [columns] : columns;
    if (indexData['unique']) {
        table.unique(columns, indexData['name']);
    } else {
        table.index(columns, indexData['name']);
    }
};

/**
 * Manually create the foreign keys from a table description object.
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableDescription} tableData The table data
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var createTableForeignKeys = function (db, tableName, tableData, callback) {

    var promise = db.schema
        .table(tableName, function(table) {

            (tableData['foreign_keys'] || []).forEach(function (foreignKeyData) {
                createForeign_inner(table, foreignKeyData);
            });

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Manually create an foreign key
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableForeignKeyDescription} foreignKey The foreign key data
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var createForeign = function (db, tableName, foreignKey, callback) {

    var promise = db.schema
        .table(tableName, function(table) {
            createForeign_inner(table, foreignKey);
        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Inner implementation for foreign key creation
 * @param {Object} table A knex table closure
 * @param {TableForeignKeyDescription} foreignKey The foreign key data
 */
var createForeign_inner = function (table, foreignKey) {
    var columns = foreignKey['columns'],
        foreigns = foreignKey['foreign_columns'];
    columns = (columns && !(columns instanceof Array)) ? [columns] : columns;
    foreigns = (foreigns && !(foreigns instanceof Array)) ? [foreigns] : foreigns;
    var foreign = table.foreign(columns).references(foreigns).inTable(foreignKey['foreign_table']);
    if (foreignKey['on_update']) {
        foreign.onUpdate(foreignKey['on_update']);
    }
    if (foreignKey['on_delete']) {
        foreign.onDelete(foreignKey['on_delete']);
    }
};

/**
 * Kick off the installation routine.
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?)?} callback
 * @returns {Promise.<Number>|*}
 */
var install = function (db, schemaPath, callback) {

    var dbTables = {}, dbRawQueries = [];

    var promise = readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true)
        .then(function (schema) {

            if (schema['schema'] && !Array.isArray(schema['schema']['columns'])) {

                dbTables = schema['schema'];
                dbRawQueries = schema['raw'] || [];

            } else {

                dbTables = schema;

            }

        })
        .then(function () {

            // Execute schema building

            return Bluebird.each(Object.keys(dbTables), function (tableName) {
                return createTable(db, tableName, dbTables[tableName]);
            });

        })
        .then(function () {

            // Execute raw queries

            return Bluebird.each(dbRawQueries, function (rawQuery) {

                if (Array.isArray(rawQuery) && typeof(rawQuery[0]) === 'string') {
                    rawQuery = rawQuery.join('\n');
                }

                if (rawQuery && typeof(rawQuery) === 'string') {
                    return db.raw(rawQuery);
                }

            });

        })
        .then(function () {

            return Bluebird.each(Object.keys(dbTables), function (tableName) {

                return createTableIndexes(db, tableName, dbTables[tableName])
                    .catch(function (err) {

                        err = 'Failed to create indexes for table ' + tableName + '\n' + err.toString();
                        throw err;

                    });

            });
        })
        .then(function () {

            return Bluebird.each(Object.keys(dbTables), function (tableName) {

                return createTableForeignKeys(db, tableName, dbTables[tableName])
                    .catch(function (err) {

                        err = 'Failed to create foreign keys for table ' + tableName + '\n' + err.toString();
                        throw err;

                    });

            });
        })
        .then(function () {

            return getLatestDbVersion(schemaPath)
                .then(function (version) {
                    return setCurrentDbVersion(db, version);
                });

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Kick off the upgrade routine.
 * This will check the current db schema version against the latest, and run the appropriate upgrade routines.
 * If it detects that the db is not even installed (no version specified), then the returned error will be 'empty-database' (String)
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?)?} callback
 * @returns {Promise.<T>|*}
 */
var upgrade = function (db, schemaPath, callback) {

    var schema, currentVersion, latestVersion, originalVersion, saveVersion;

    var promise = readJsonFilePromisified(Path.join(schemaPath, 'schema.json'), true)
        .then(function (schemaJson) {

            if (schemaJson['schema'] && !Array.isArray(schemaJson['schema']['columns'])) {
                schemaJson = schemaJson['schema'];
            }

            schema = schemaJson;

        })
        .then(function () {

            return getCurrentDbVersion(db)
                .then(function (version) {
                    originalVersion = currentVersion = version;

                    return getLatestDbVersion(schemaPath);
                })
                .then(function (version) {
                    latestVersion = version;
                });

        })
        .then(function () {

            // While the current version hasn't yet reached the latest version
            return promiseWhile(
                function () { return currentVersion < latestVersion; },
                function () {

                    // Load the correct upgrade.####.json file, then perform the relevant actions.

                    var hasUpgradeSchema = false;
                    var upgradeSchema;

                    return readJsonFilePromisified(Path.join(schemaPath, 'upgrade.' + (currentVersion + 1) + '.json'), true)
                        .then(function (schema) {
                            upgradeSchema = schema;
                            hasUpgradeSchema = true;
                        })
                        .then(function () {

                            return Bluebird.each(upgradeSchema, function (action) {

                                var softThrow = function (err) {
                                    if (err && action['ignore_errors']) {
                                        console.log('Ignoring error', err);
                                        err = null;
                                    } else if (err) {
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
                                        var rawQuery = action['query'];
                                        if (Array.isArray(rawQuery) && typeof(rawQuery[0]) === 'string') {
                                            rawQuery = rawQuery.join('\n');
                                        }

                                        return db.raw(rawQuery).catch(softThrow);
                                        break;

                                    case 'createTable':
                                        if (schema[action['table']]) {
                                            return createTable(db, action['table'], schema[action['table']]).catch(softThrow);
                                        } else {
                                            console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'createTableIndexes':
                                        if (schema[action['table']]) {
                                            return createTableIndexes(db, action['table'], schema[action['table']]).catch(softThrow);
                                        } else {
                                            console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'createTableForeignKeys':
                                        if (schema[action['table']]) {
                                            return createTableForeignKeys(db, action['table'], schema[action['table']]).catch(softThrow);
                                        } else {
                                            console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'addColumn':
                                        if (schema[action['table']]) {
                                            var column = schema[action['table']]['columns'].filter(function(item){ return item['name'] === action['column']; })[0];
                                            if (column) {
                                                return db.schema
                                                    .table(action['table'], function(table){
                                                        createColumn(table, column);
                                                    })
                                                    .catch(softThrow);
                                            } else {
                                                console.log('Unknown column named `' + action['column'] + '`. Failing...');
                                                softThrow('unknown-column');
                                            }
                                        } else {
                                            console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                            softThrow('unknown-table');
                                        }
                                        break;

                                    case 'renameColumn':
                                        return db.schema
                                            .table(action['table'], function(table){
                                                table.renameColumn(action['from'], action['to']);
                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'createIndex':
                                        return createIndex(db, action['table'], action).catch(softThrow);
                                        break;

                                    case 'createForeign':
                                        return createForeign(db, action['table'], action).catch(softThrow);
                                        break;

                                    case 'dropColumn':
                                        return db.schema
                                            .table(action['table'], function(table){
                                                table.dropColumn(action['column']);
                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'dropTable':
                                        return db.schema.dropTableIfExists(action['table']).catch(softThrow);
                                        break;

                                    case 'dropPrimary':
                                        return db.schema
                                            .table(action['table'], function(table){
                                                table.dropPrimary();
                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'dropIndex':
                                        return db.schema
                                            .table(action['table'], function(table){

                                                if (action['name']) {
                                                    table.dropIndex(null, action['name']);
                                                } else {
                                                    table.dropIndex(action['column']);
                                                }

                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'dropForeign':
                                        return db.schema
                                            .table(action['table'], function(table){

                                                if (action['name']) {
                                                    table.dropForeign(null, action['name']);
                                                } else {
                                                    table.dropForeign(action['column']);
                                                }

                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'dropUnique':
                                        return db.schema
                                            .table(action['table'], function(table){

                                                if (action['name']) {
                                                    table.dropUnique(null, action['name']);
                                                } else {
                                                    table.dropUnique(action['column']);
                                                }

                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'addTimestamps':
                                        return db.schema
                                            .table(action['table'], function(table){
                                                table.timestamps();
                                            })
                                            .catch(softThrow);
                                        break;

                                    case 'dropTimestamps':
                                        return db.schema
                                            .table(action['table'], function(table){
                                                table.dropTimestamps();
                                            })
                                            .catch(softThrow);
                                        break;

                                    default:
                                        console.log('Unknown upgrade action `' + action['action'] + '`. Failing...');
                                        softThrow('unknown-action');
                                        break;
                                }

                            });

                        })
                        .then(function () {
                            currentVersion++;
                        })
                        .catch(function (err) {

                            if (!hasUpgradeSchema) {
                                if (err instanceof SyntaxError) {
                                    console.log('Upgrade schema for version ' + (currentVersion + 1) +
                                        ' (upgrade.' + (currentVersion + 1) + '.json)' +
                                        ' contains invalid JSON. Please correct it and try again.');
                                } else {
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
                .then(function () {
                    saveVersion = latestVersion;
                })
                .catch(function (err) {
                    saveVersion = currentVersion;

                    // Rethrow that error
                    throw err;
                });

        })
        .then(function () {
            return setCurrentDbVersion(db, saveVersion);
        })
        .catch(function (err) {

            if (originalVersion === undefined) {
                throw 'empty-database';
            } else {
                // Save the point to which we've successfully made it...
                return setCurrentDbVersion(db, saveVersion)
                    .then(function () {
                        // Rethrow that error
                        throw err;
                    });
            }

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Ensures that the schema_globals exists.
 * @param {Object} db A knex instance
 * @param {function(error:?,created:Boolean)?} callback
 * @returns {Promise.<Boolean>|*}
 */
var ensureSchemaGlobalsExist = function (db, callback) {

    var promise = db.schema
        .hasTable('schema_globals')
        .then(function(exists){

            if (exists) {
                return false;
            } else {
                return db.schema
                    .createTable('schema_globals', function(table){
                        table.string('key', 64).notNullable().primary();;
                        table.string('value', 255);
                    })
                    .then(function(){
                        return true;
                    });
            }

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Retrieves the schema version of the current db
 * @param {Object} db A knex instance
 * @param {function(error:?,version:Number)?} callback
 * @returns {Promise.<Number?>|*}
 */
var getCurrentDbVersion = function (db, callback) {

    var promise = ensureSchemaGlobalsExist(db)
        .then(function () {

            return db.select('value')
                .from('schema_globals')
                .where('key', 'db_version')
                .limit(1)
                .then(function (rows) {
                    return (rows && rows.length) ? parseFloat(rows[0]['value']) : null;
                })
        })

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Sets the schema version of the current db
 * @param {Object} db A knex instance
 * @param {Number} version A version, as a whole number
 * @param {function(error:?,version:Number)?} callback
 * @returns {Promise.<Number>|*}
 */
var setCurrentDbVersion = function (db, version, callback) {

    var promise = getCurrentDbVersion(db)
        .then(function (currentDbVersion) {

            if (currentDbVersion == null) {
                return db
                    .insert({'value': version, 'key': 'db_version'})
                    .into('schema_globals')
                    .then(function () {
                        return version;
                    });

            } else {
                return db
                    .table('schema_globals')
                    .update('value', version)
                    .where('key', 'db_version')
                    .then(function () {
                        return version;
                    });
            }

        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Retrieves the latest schema version which is specified in version.json
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,version:Number?)?} callback
 * @returns {Promise.<Number>|*}
 */
var getLatestDbVersion = function (schemaPath, callback) {

    var promise = readJsonFilePromisified(Path.join(schemaPath, 'version.json'), true)
        .then(function (data) {
            if (data) {
                return data['version'];
            }

            return null;
        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Determine if a schema upgrade is required
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,isUpgradeNeeded:Boolean?)?} callback
 * @returns {Promise.<Boolean>|*}
 */
var isUpgradeNeeded = function (db, schemaPath, callback) {

    var promise = getCurrentDbVersion(db)
        .then(function (dbVer) {

            return getLatestDbVersion(schemaPath)
                .then(function (latestVersion) {
                    return dbVer < latestVersion;
                })
        });

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

/**
 * Determine if a full schema installation is required
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,isInstallNeeded:Boolean?)?} callback
 * @returns {Promise.<Boolean>|*}
 */
var isInstallNeeded = function (db, schemaPath, callback) {

    var promise = getCurrentDbVersion(db)
        .then(function (version) {
            return version == null;
        })

    if (typeof callback === 'function') {
        promise.asCallback(callback);
    }

    return promise;
};

module.exports = {
    isInstallNeeded: isInstallNeeded,
    isUpgradeNeeded: isUpgradeNeeded,

    install: install,
    upgrade: upgrade,

    getCurrentDbVersion: getCurrentDbVersion,
    setCurrentDbVersion: setCurrentDbVersion,
    getLatestDbVersion: getLatestDbVersion,

    createColumn: createColumn,
    createTable: createTable,
    createTableIndexes: createTableIndexes,
    createTableForeignKeys: createTableForeignKeys,
    createIndex: createIndex,

    mysqlBackup: require('./backup/mysql')
};
