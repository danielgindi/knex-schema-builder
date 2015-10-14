"use strict";

var Promise = require('bluebird');

/** @const */
var NEW_LINE = '\r\n';

/** @const */
var DELIMITER = '$$';

/** @typedef {{wrapInTransaction: bool?, routines: bool?, triggers: bool?, dropTable: bool?, tableStructure: bool?, tableData: bool?}} MysqlBackupOptions */

/**
 * @enum {string}
 */
var DbObjectType = {
    Procedure: 'Procedure',
    Function: 'Function',
    Event: 'Event',
    View: 'View',
    Table: 'Table',
    Trigger: 'Trigger'
};

/**
 * Returns MYSQL representation of the object type
 * @param {DbObjectType} type
 */
var dbObjectTypeFromType = function (type) {
    switch (type) {
        case DbObjectType.Procedure: return 'Procedure';
        case DbObjectType.Function: return 'Function';
        case DbObjectType.Event: return 'Event';
        case DbObjectType.View: return 'View';
        case DbObjectType.Table: return 'Table';
        case DbObjectType.Trigger: return 'Trigger';
    }
    return null;
};

/**
 * Wraps an object name for MySql
 * @param {string} name
 * @returns {string}
 */
var wrapObjectName = function (name) {
    return '`' + name.replace(/`/g, '``') + '`';
};

var MysqlBackupController = {

    /**
     * Exports the db structure and data to the specified stream
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {bluebird}
     */
    generateBackup: function (knex, outputStream, options) {

        outputStream.write('DELIMITER ' + DELIMITER + NEW_LINE);
        outputStream.write('SET FOREIGN_KEY_CHECKS=0 ' + DELIMITER + NEW_LINE);
        outputStream.write('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO" ' + DELIMITER + NEW_LINE);
        outputStream.write('SET AUTOCOMMIT=0 ' + DELIMITER + NEW_LINE);

        if (options.wrapInTransaction) {
            outputStream.write('START TRANSACTION ' + DELIMITER + NEW_LINE);
        }

        return Promise.resolve().then(function () {

            if (options.routines) {
                return MysqlBackupController.exportRoutines(knex, outputStream, options);
            }

        }).then(function () {

            if (options.tableStructure) {
                return MysqlBackupController.exportTableStructure(knex, outputStream, options);
            }

        }).then(function () {

            if (options.tableData) {
                return MysqlBackupController.exportTableData(knex, outputStream, options);
            }

        }).then(function () {

            if (options.triggers) {
                return MysqlBackupController.exportTriggers(knex, outputStream, options);
            }

        }).then(function () {

            outputStream.write('SET FOREIGN_KEY_CHECKS=1 ' + DELIMITER + NEW_LINE);

        }).then(function () {

            if (options.wrapInTransaction) {
                outputStream.write('COMMIT ' + DELIMITER + NEW_LINE);
            }

        });
    },

    /**
     * Exports a CREATE query for an object by type and name
     * @param {knex} knex
     * @param {DbObjectType} objectType
     * @param {String} objectName
     * @param {Boolean = false} ifNotExists
     * @returns {bluebird}
     */
    getObjectCreate: function (knex, objectType, objectName, ifNotExists) {

        var sql = 'SHOW CREATE ' + dbObjectTypeFromType(objectType) + ' ' + wrapObjectName(objectName);

        return knex.raw(sql).then(function (resp) {

            var rows = resp[0];
            if (!rows.length) {
                throw new Error('Object not found: ' + objectName);
            }

            var resultColumn = '';

            switch (objectType)
            {
                case DbObjectType.Procedure:
                    resultColumn = "Create Procedure";
                    break;
                case DbObjectType.Function:
                    resultColumn = "Create Function";
                    break;
                case DbObjectType.Event:
                    resultColumn = "Create Event";
                    break;
                case DbObjectType.View:
                    resultColumn = "Create View";
                    break;
                case DbObjectType.Table:
                    resultColumn = "Create Table";
                    break;
                case DbObjectType.Trigger:
                    resultColumn = "SQL Original Statement";
                    break;
            }

            var create = rows[0][resultColumn];

            if (ifNotExists && create) {
                create = create.replace(/^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?PROCEDURE\s+)(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)/, 'DROP PROCEDURE IF EXISTS $5 ' + DELIMITER.replace(/\$/g, '$$$$') + NEW_LINE + '$1$5');
                create = create.replace(/^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?FUNCTION\s+)(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)/, 'DROP FUNCTION IF EXISTS $5 ' + DELIMITER.replace(/\$/g, '$$$$') + NEW_LINE + '$1$5');
                create = create.replace(/^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?EVENT\s+)/, '$1IF NOT EXISTS ');
                create = create.replace(/^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?TRIGGER\s+)/, '$1IF NOT EXISTS ');
                create = create.replace(/^(CREATE\s+VIEW)/, '$1 OR REPLACE');
                create = create.replace(/^(CREATE\s+TABLE)/, '$1 IF NOT EXISTS');
            }

            return create;
        });
    },

    /**
     * Exports an object list by objectType
     * @param {knex} knex
     * @param {DbObjectType} objectType
     * @returns {bluebird}
     */
    getObjectList: function (knex, objectType) {

        var query;
        switch (objectType)
        {
            case DbObjectType.Table:
                query = knex.select('TABLE_NAME AS name').
                    from('INFORMATION_SCHEMA.TABLES')
                    .where('TABLE_SCHEMA', knex.raw('DATABASE()'))
                    .andWhere('TABLE_TYPE', 'BASE TABLE');
                break;
            case DbObjectType.Event:
                query = knex.select('EVENT_NAME AS name').
                    from('INFORMATION_SCHEMA.EVENTS')
                    .where('EVENT_SCHEMA', knex.raw('DATABASE()'));
                break;
            case DbObjectType.Function:
            case DbObjectType.Procedure:
                query = knex.select('SPECIFIC_NAME AS name').
                    from('INFORMATION_SCHEMA.ROUTINES')
                    .where('ROUTINE_SCHEMA', knex.raw('DATABASE()'))
                    .where('ROUTINE_TYPE', objectType === DbObjectType.Function ? 'FUNCTION' : 'PROCEDURE');
                break;
            case DbObjectType.View:
                query = knex.select('TABLE_NAME AS name').
                    from('INFORMATION_SCHEMA.TABLES')
                    .where('TABLE_SCHEMA', knex.raw('DATABASE()'))
                    .andWhere('TABLE_TYPE', 'VIEW');
                break;
            case DbObjectType.Trigger:
                query = knex.select('TRIGGER_NAME AS name').
                    from('INFORMATION_SCHEMA.TRIGGERS')
                    .where('TRIGGER_SCHEMA', knex.raw('DATABASE()'));
                break;
            default:
                return Promise.resolve([]);
                break;
        }

        var results = [];

        return query.then(function (rows) {

            rows.forEach(function (row) {

                results.push(row['name']);

            });

            return results;
        });
    },

    /**
     * Tests to see if an object is a view (good for tables)
     * @param {knex} knex
     * @param {String} tableName
     * @returns {bluebird}
     */
    isView: function (knex, tableName) {

        return knex.select('TABLE_NAME')
            .from('information_schema.VIEWS')
            .where('TABLE_SCHEMA', knex.raw('SCHEMA()'))
            .andWhere('TABLE_NAME', tableName)
            .then(function (rows) {
            return rows.length && rows[0]['TABLE_NAME'] != null;
        });
    },

    /**
     * Exports the routines only
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {bluebird}
     */
    exportRoutines: function (knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Procedure).then(function (procedures) {

            return Promise.each(procedures, function (procName) {

                outputStream.write('DROP PROCEDURE IF EXISTS ' + wrapObjectName(procName) + ' ' + DELIMITER + NEW_LINE);

                return MysqlBackupController.getObjectCreate(knex, DbObjectType.Procedure, procName, false)
                    .then(function (createSql) {

                        outputStream.write(createSql + ' ' + DELIMITER + NEW_LINE);

                    });
            });

        }).then(function () {

            return MysqlBackupController.getObjectList(knex, DbObjectType.Function).then(function (functions) {

                return Promise.each(functions, function (funcName) {

                    outputStream.write('DROP PROCEDURE IF EXISTS ' + wrapObjectName(funcName) + ' ' + DELIMITER + NEW_LINE);

                    return MysqlBackupController.getObjectCreate(knex, DbObjectType.Function, funcName, false)
                        .then(function (createSql) {

                            outputStream.write(createSql + ' ' + DELIMITER + NEW_LINE);

                        });
                });

            })

        });

    },

    /**
     * Exports the tables and views structure (Tables first, as views depend on tables)
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {bluebird}
     */
    exportTableStructure: function (knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Table).then(function (tables) {

            var views = [];

            return Promise.each(tables, function (tableName) {

                return MysqlBackupController.isView(knex, tableName)
                    .then(function (isView) {

                        if (isView) {
                            views.push(tableName);
                            return;
                        }

                        if (options.dropTable) {
                            outputStream.write('DROP TABLE IF EXISTS ' + wrapObjectName(tableName) + ' ' + DELIMITER + NEW_LINE);
                        }

                        return MysqlBackupController.getObjectCreate(knex, DbObjectType.Table, tableName, !options.dropTable)
                            .then(function (createSql) {
                                outputStream.write(createSql + ' ' + DELIMITER + NEW_LINE);
                            });

                    });

            }).then(function () {

                return Promise.each(views, function (viewName) {

                    if (options.dropTable) {
                        outputStream.write('DROP VIEW IF EXISTS ' + wrapObjectName(viewName) + ' ' + DELIMITER + NEW_LINE);
                    }

                    return MysqlBackupController.getObjectCreate(knex, DbObjectType.View, viewName, !options.dropTable)
                        .then(function (createSql) {
                            outputStream.write(createSql + ' ' + DELIMITER + NEW_LINE);
                        });

                })

            });

        });

    },

    /**
     * Exports the table data
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {bluebird}
     */
    exportTableData: function (knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Table).then(function (tables) {

            return Promise.each(tables, function (tableName) {

                return MysqlBackupController.isView(knex, tableName)
                    .then(function (isView) {

                        if (isView) return;

                        var resolver = Promise.pending();

                        knex.select('*')
                            .from(tableName)
                            // Dataset may be very large, we want to stream it in and out
                            .stream(function (stream) {
                                stream.on('data', function (row) {

                                    outputStream.write(knex.insert(row).into(tableName).toString() + ' ' + DELIMITER +  NEW_LINE);

                                }).on('end', function () {
                                    resolver.resolve();
                                });
                            })
                            .catch(function (err) {
                                resolver.reject(err);
                            });

                        return resolver;

                    });

            });

        });

    },

    /**
     * Exports the table data
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {bluebird}
     */
    exportTriggers: function (knex, outputStream, options) {

        return knex.select(
            'TRIGGER_NAME AS Trigger',
            'ACTION_TIMING AS Timing',
            'ACTION_ORIENTATION AS Orientation',
            'EVENT_MANIPULATION AS Event',
            'EVENT_OBJECT_TABLE AS Table',
            'ACTION_STATEMENT AS Statement')
            .from('INFORMATION_SCHEMA.TRIGGERS')
            .where('TRIGGER_SCHEMA', knex.raw('DATABASE()'))
            .orderBy('ACTION_ORDER', 'asc')
            .then(function (rows) {

                rows.forEach(function (row) {

                    outputStream.write('CREATE TRIGGER ' + wrapObjectName(row['Trigger']) + ' ');
                    outputStream.write(row['Timing'] + ' ' + row['Event'] + ' ON ' + wrapObjectName(row['Table']) + ' ');
                    outputStream.write('FOR EACH ' + row['Orientation'] + ' ');
                    outputStream.write(row['Statement'] + ' ' + DELIMITER + NEW_LINE);

                });

            });

    }

};

module.exports = MysqlBackupController;