"use strict";

var path = require('path'),
    async = require('async'),
    fs = require('fs'),
    stripJsonComments = require('strip-json-comments'),
    knex = require('knex');

// A little helper that goes with me everywhere

var readJsonFile = function (path, stripComments, callback) {

    if (callback === undefined && typeof stripComments === 'function') {
        callback = stripComments;
        stripComments = false;
    }

    fs.readFile(path, 'utf8', function (err, json) {
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

    var unsigned = type.startsWith('unsigned ');
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

};

/**
 * Manually create the table from a table description object.
 * This does not create the indexes or foreign keys - they are created in different calls.
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableDescription} tableData The table data
 * @param {function(error:?)} callback
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

    table.exec(callback);

};

/**
 * Manually create the indexes from a table description object.
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableDescription} tableData The table data
 * @param {function(error:?)} callback
 */
var createTableIndexes = function (db, tableName, tableData, callback) {

    db.schema.table(tableName, function(table) {

        (tableData['indexes'] || []).forEach(function (index) {
            createIndex_inner(table, index);
        });

    }).exec(callback);

};

/**
 * Manually create an index
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableIndexDescription} indexData The index data
 * @param {function(error:?)} callback
 */
var createIndex = function (db, tableName, indexData, callback) {
    db.schema.table(tableName, function(table) {
        createIndex_inner(table, indexData);
    }).exec(callback);
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
 * @param {function(error:?)} callback
 */
var createTableForeignKeys = function (db, tableName, tableData, callback) {

    db.schema.table(tableName, function(table) {

        (tableData['foreign_keys'] || []).forEach(function (foreignKeyData) {
            createForeign_inner(table, foreignKeyData);
        });

    }).exec(callback);

};

/**
 * Manually create an foreign key
 * @param {Object} db A knex instance
 * @param {String} tableName The name of the table to create
 * @param {TableForeignKeyDescription} foreignKey The foreign key data
 * @param {function(error:?)} callback
 */
var createForeign = function (db, tableName, foreignKey, callback) {
    db.schema.table(tableName, function(table) {
        createForeign_inner(table, foreignKey);
    }).exec(callback);
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
 * @param {function(error:?)} callback
 */
var install = function (db, schemaPath, callback) {

    async.waterfall(
        [
            function (callback) {
                readJsonFile(path.join(schemaPath, 'schema.json'), true, function (err, data) {
                    callback(err, data);
                });
            },
            function (schema, callback) {

                async.eachSeries(Object.keys(schema), function (tableName, callback) {
                    createTable(db, tableName, schema[tableName], callback);
                }, function (err) {
                    callback(err, schema);
                });

            },
            function (schema, callback) {

                var currentTableName;

                async.eachSeries(Object.keys(schema), function (tableName, callback) {
                    currentTableName = tableName;
                    createTableIndexes(db, tableName, schema[tableName], callback);
                }, function (err) {
                    if (err) {
                        err = 'Failed to create indexes for table ' + currentTableName + '\n' + err.toString();
                    }
                    callback(err, schema);
                });

            },
            function (schema, callback) {

                var currentTableName;

                async.eachSeries(Object.keys(schema), function (tableName, callback) {
                    currentTableName = tableName;
                    createTableForeignKeys(db, tableName, schema[tableName], callback);
                }, function (err) {
                    if (err) {
                        err = 'Failed to create foreign keys for table ' + currentTableName + '\n' + err.toString();
                    }
                    callback(err, schema);
                });

            },
            function (schema, callback) {
                getLatestDbVersion(schemaPath, callback);
            },
            function (version, callback) {
                setCurrentDbVersion(db, version, callback);
            }
        ],
        function (err) {

            callback(err);

        }
    );
};

/**
 * Kick off the upgrade routine.
 * This will check the current db schema version against the latest, and run the appropriate upgrade routines.
 * If it detects that the db is not even installed (no version specified), then the returned error will be 'empty-database' (String)
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?)} callback
 */
var upgrade = function (db, schemaPath, callback) {

    var originalVersion;

    async.waterfall(
        [
            function (callback) {
                readJsonFile(path.join(schemaPath, 'schema.json'), true, function (err, data) {
                    callback(err, data);
                });
            },
            function (schema, callback) {
                getCurrentDbVersion(db, function(err, currentVersion){
                    callback(err, schema, parseInt(currentVersion, 10));
                });
            },
            function (schema, currentVersion, callback) {
                originalVersion = currentVersion;

                getLatestDbVersion(schemaPath, function(err, latestVersion){
                    callback(err, schema, currentVersion, latestVersion);
                });
            },
            function (schema, currentVersion, latestVersion, callback) {

                // While the current version hasn't yet reached the latest version

                async.whilst(
                    function () { return currentVersion < latestVersion; },
                    function (callback) {

                        // Load the correct upgrade.####.json file, then perform the relevant actions.

                        var hasUpgradeSchema = false;

                        async.waterfall(
                            [
                                function (callback) {
                                    readJsonFile(path.join(schemaPath, 'upgrade.' + (currentVersion + 1) + '.json'), true, function (err, data) {
                                        callback(err, data);
                                    });
                                },
                                function (upgradeSchema, callback) {
                                    hasUpgradeSchema = true;

                                    async.eachSeries(upgradeSchema, function (action, callback) {

                                        switch (action['action']) {
                                            case 'execute':
                                                db.raw(action['query']).exec(callback);
                                                break;
                                            case 'createTable':
                                                if (schema[action['table']]) {
                                                    createTable(db, action['table'], schema[action['table']], callback);
                                                } else {
                                                    console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                                    callback('unknown-table');
                                                }
                                                break;
                                            case 'createTableIndexes':
                                                if (schema[action['table']]) {
                                                    createTableIndexes(db, action['table'], schema[action['table']], callback);
                                                } else {
                                                    console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                                    callback('unknown-table');
                                                }
                                                break;
                                            case 'createTableForeignKeys':
                                                if (schema[action['table']]) {
                                                    createTableForeignKeys(db, action['table'], schema[action['table']], callback);
                                                } else {
                                                    console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                                    callback('unknown-table');
                                                }
                                                break;
                                            case 'addColumn':
                                                if (schema[action['table']]) {
                                                    var column = schema[action['table']]['columns'].filter(function(item){ return item['name'] === action['column']; })[0];
                                                    if (column) {
                                                        db.schema.table(action['table'], function(table){
                                                            createColumn(table, column);
                                                        }).exec(callback);
                                                    } else {
                                                        console.log('Unknown column named `' + action['column'] + '`. Failing...');
                                                        callback('unknown-column');
                                                    }
                                                } else {
                                                    console.log('Unknown table named `' + action['table'] + '`. Failing...');
                                                    callback('unknown-table');
                                                }
                                                break;
                                            case 'renameColumn':
                                                db.schema.table(action['table'], function(table){
                                                    table.renameColumn(action['from'], action['to']);
                                                }).exec(callback);
                                                break;
                                            case 'createIndex':
                                                createIndex(db, action['table'], action, callback);
                                                break;
                                            case 'createForeign':
                                                createForeign(db, action['table'], action, callback);
                                                break;
                                            case 'dropColumn':
                                                db.schema.table(action['table'], function(table){
                                                    table.dropColumn(action['column']);
                                                }).exec(callback);
                                                break;
                                            case 'dropTable':
                                                db.schema.dropTableIfExists(action['table']).exec(callback);
                                                break;
                                            case 'dropPrimary':
                                                db.schema.table(action['table'], function(table){
                                                    table.dropPrimary();
                                                }).exec(callback);
                                                break;
                                            case 'dropIndex':
                                                db.schema.table(action['table'], function(table){

                                                    if (action['name']) {
                                                        table.dropIndex(null, action['name']);
                                                    } else {
                                                        table.dropIndex(action['column']);
                                                    }

                                                }).exec(callback);
                                                break;
                                            case 'dropForeign':
                                                db.schema.table(action['table'], function(table){

                                                    if (action['name']) {
                                                        table.dropForeign(null, action['name']);
                                                    } else {
                                                        table.dropForeign(action['column']);
                                                    }

                                                }).exec(callback);
                                                break;
                                            case 'dropUnique':
                                                db.schema.table(action['table'], function(table){

                                                    if (action['name']) {
                                                        table.dropUnique(null, action['name']);
                                                    } else {
                                                        table.dropUnique(action['column']);
                                                    }

                                                }).exec(callback);
                                                break;
                                            case 'addTimestamps':
                                                db.schema.table(action['table'], function(table){
                                                    table.timestamps();
                                                }).exec(callback);
                                                break;
                                            case 'dropTimestamps':
                                                db.schema.table(action['table'], function(table){
                                                    table.dropTimestamps();
                                                }).exec(callback);
                                                break;
                                            default:
                                                console.log('Unknown upgrade action `' + action['action'] + '`. Failing...');
                                                callback('unknown-action');
                                                break;
                                        }

                                    }, callback);
                                }

                            ], function(err){

                                if (err && !hasUpgradeSchema) {
                                    console.log('Upgrade schema for version ' + (currentVersion + 1) + ' (upgrade.' + currentVersion + '.json) not found, skipping...');
                                    err = false;
                                }

                                if (!err) {
                                    currentVersion++;
                                }

                                callback(err);

                            }
                        );

                    },
                    function (err) {
                        callback(err, err ? currentVersion : latestVersion);
                    }
                );

            }
        ],
        function (err, saveVersion) {

            if (err) {
                if (originalVersion === undefined) {
                    callback('empty-database');
                } else {
                    setCurrentDbVersion(db, saveVersion, function() {
                        callback(err);
                    });
                }
            } else {
                setCurrentDbVersion(db, saveVersion, function(err) {
                    callback(err);
                });
            }

        }
    );

};

var ensureSchemaGlobalsExist = function (db, callback) {

    db.schema.hasTable('schema_globals').then(function(exists){

        if (exists) {
            callback();
        } else {
            db.schema.createTable('schema_globals', function(table){
                table.string('key', 64).notNullable();
                table.string('value', 255);
            }).then(function(){
                callback();
            }).catch(function(err){
                callback(err);
            });
        }

    }).catch(function(err){
        callback(err);
    });

};

/**
 * Retrieves the schema version of the current db
 * @param {Object} db A knex instance
 * @param {function(error:?,version:Boolean)} callback
 */
var getCurrentDbVersion = function (db, callback) {

    ensureSchemaGlobalsExist(db, function(err) {
        if (err) return callback(err);

        db.select('value').from('schema_globals').where('key', 'dv_version').limit(1).exec(function(err, rows){
            callback(err, (rows && rows.length) ? rows[0]['value'] : null);
        });
    });

};

/**
 * Sets the schema version of the current db
 * @param {Object} db A knex instance
 * @param {Number} version A version, as a whole number
 * @param {function(error:?)} callback
 */
var setCurrentDbVersion = function (db, version, callback) {

    ensureSchemaGlobalsExist(db, function(err) {
        if (err) return callback(err);

        db.insert({'value': version, 'key': 'dv_version'}).into('schema_globals').then(function(){

            callback();

        }).catch(function(){

            db.table('schema_globals').update('value', version).where('key', 'dv_version').then(function(){
                callback();
            }).catch(function(error){
                callback(error);
            });

        })
    });

};

/**
 * Retrieves the latest schema version which is specific in version.json
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,version:Boolean?)} callback
 */
var getLatestDbVersion = function (schemaPath, callback) {

    readJsonFile(path.join(schemaPath, 'version.json'), true, function (err, data) {
        callback(err, data ? data["version"] : null);
    });

};

/**
 * Determine if a schema upgrade is required
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,isUpgradeNeeded:Boolean?)} callback
 */
var isUpgradeNeeded = function (db, schemaPath, callback) {

    async.series([
            function (callback) {
                getCurrentDbVersion(db, callback);
            },
            function (callback) {
                getLatestDbVersion(schemaPath, callback);
            }
        ],
        function (err, versions) {
            if (err) return callback(err);

            callback(false, versions[0] < versions[1]);
        }
    );

};

/**
 * Determine if a full schema installation is required
 * @param {Object} db A knex instance
 * @param {String} schemaPath Path to where the schema files reside
 * @param {function(error:?,isInstallNeeded:Boolean?)} callback
 */
var isInstallNeeded = function (db, schemaPath, callback) {

    getCurrentDbVersion(db, function (err, version) {
            if (err) return callback(err);

            callback(false, version == null);
        }
    );

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
    createIndex: createIndex
};