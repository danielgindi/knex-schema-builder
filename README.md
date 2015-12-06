knex-schema-builder
===================

[![npm Version](https://badge.fury.io/js/knex-schema-builder.png)](https://npmjs.org/package/knex-schema-builder)

I built this little helper so I can have a way of easily describing a database schema and automate the process of database initialization for an installation of a project - or migration of the database to newer versions.
It works on top of *knex*, and most functions require passing a *knex* instance.

The concept is like this:

1. You have a folder in your project containing the description of the schema.
   * `schema.json` - Contains the full schema for a fresh installation (used also for data in upgrade schemas)
   * `upgrade.####.json` - Contains an upgrade script for a single version
   * `version.json` - Contains the current DB version. A version is a whole number, and is 1-based. You could start with any number you like.
2. You call either `install` or `upgrade` in order to install a fresh database or migrate.
3. You can call `isInstallNeeded` and `isUpgradeNeeded` to determine if you need to call `install` or `upgrade`. Maybe use it to automatically redirect to a screen telling the admin that a fresh installation or an upgrade process is about to begin...
4. You can manually call individual helper functions to create a table, column etc. (i.e. when you create tables dynamically with a predefined schema...)

Usage example:

```javascript

var knex = require('knex'),
    schemaInstaller = require('knex-schema-builder'),
    db = knex(require('./db-config.js')),
    schemaPath = path.join(__dirname, './db_schema');

// In order to initialize a fresh db
schemaInstaller.install(db, schemaPath, function (err) { ... });

// In order to upgrade a db... We can call "upgrade" directly, 
//   or we can tell the user that an upgrade is needed and that 
//   he should authorize the upgrade process.
schemaInstaller.isUpgradeNeeded(db, schemaPath, function (err, required) {

  if (err) {

    // Handle error...

  } else {

    if (required) {

      installer.upgrade(db, schemaPath, function(err){

        if (err) {
          // An error occurred...
          // Please take care of the problem manually, 
          // and then try to run the upgrade routine again.
        } else {
          // Your database has been upgraded successfully!
        }

      });

    } else {

      // Your database is up to date! No upgrade needed

    }

  }

});

```

## Structure for the *version.json*

Simply
````javascript
{ "version": 1 }
````

## Structure for the *upgrade.####.json*

Name of each file contains the version to which you upgrade to.
i.e upgrade.2.json contains the schema for upgrading from version 1 to version 2.

The schema is an array of actions, each action has the key `action` set, and its options. Available actions are:

* `execute (query)`: Execute the query in `query` key
* `createTable (table)`: Create the table named `table`, without its indexes and foreign keys. You usually want to postpone those to the end of the script.
* `createTableIndexes (table)`: Creates the indexes for table named `table`
* `createTableForeignKeys (table)`: Creates the foreign keys for table named `table`
* `addColumn (table, column)`: Creates the specified column (`column`) in table named `table`
* `renameColumn (table, from, to)`: Renames the `from` column to `to` in table named `table`
* `createIndex (table, name, columns, unique)`: Creates an index on the specified `table`, using the same syntax as in the schema file
* `createForeign (table, columns, foreign_table, foreign_columns, on_delete, on_update)`: Creates a foreign key on the specified `table`, using the same syntax as in the schema file
* `dropColumn (table, column)`: Drops the specified column (`column`) in table named `table`
* `dropTable (table)`: Drops the table named `table`
* `dropPrimary (table)`: Drops the primary key in the table named `table`
* `dropIndex (table, column)`: Drops the index on the specified column/columns (`column` can be an array or a single string) on table named `table`
* `dropIndex (table, name)`: Drops the index named `name` in table named `table`
* `dropForeign (table, column)`: Drops the foreign key on the specified column/columns (`column` can be an array or a single string) on table named `table`
* `dropForeign (table, name)`: Drops the foreign key named `name` in table named `table`
* `dropUnique (table, column)`: Drops the unique constraint the specified column/columns (`column` can be an array or a single string) in table named `table`
* `dropUnique (table, name)`: Drops the unique constraint named `name` in table named `table`
* `addTimestamps (table)`: Adds the timestamps (*created_at* and *updated_at*) in the table named `table`
* `dropTimestamps (table)`: Drops the timestamps (*created_at* and *updated_at*) in the table named `table`

Each action can optionally have a `min_version` and/or `max_version` to specify limits for specific action, whether or not it will be executed.
I.e if upgrading from an older version, you might not want to create certain columns as they have already been created due to a `createTable` action.

Each action can optionally have a `"ignore_errors": true` specified to ignore errors on the specific action.

## Structure for the *schema.json*

    {
        "schema": {
          "<TABLE_NAME>": {
            "columns": [
              {
                "name": "<COLUMN_NAME>",
                "type": "<TYPE>",
                "length": <LENGTH>,
                "text_type": "<TEXT_TYPE>",
                "precision": <PRECISION>,
                "scale": <SCALE>,
                "default": <DEFAULT VALUE>,
                "raw_default": <RAW DEFAULT VALUE>,
                "unique": true/false,
                "primary_key": true/false,
                "nullable": true/false,
                "enum_values": ['option1', 'options2', ...]
              },
              ...
            ],
            "indexes": [
              {
                "name": "<INDEX_NAME>",
                "columns": "<COLUMN_NAME>" or ["<COLUMN_NAME>".. ],
                "unique": true/false
              }
            ],
            "foreign_keys": [
              {
                "columns": "<COLUMN_NAME>" or ["<COLUMN_NAME>".. ],
                "foreign_table": "<FOREIGN_TABLE_NAME>",
                "foreign_columns": "<COLUMN_NAME>" or ["<COLUMN_NAME>".. ],
                "on_delete": "<FOREIGN_COMMAND>",
                "on_update": "<FOREIGN_COMMAND>"
              }
            ],
            "primary_key": ["<COLUMN_NAME>", ...],
            "engine": "<MYSQL_ENGINE_TYPE>",
            "charset": "<CHARSET>",
            "collate": "<COLLATION>",
            "timestamps": true/false // Adds a *created_at* and *updated_at* column on the database, setting these each to `dateTime` types.
          }
        },

        "raw": [
            "A raw query here",

            [
                "multiline raw query",
                "separated by a comma"
            ]
        ]
    }

#### *TYPE*:
* `unsigned <TYPE>` (Makes an unsigned type)
* `increments` / `bigIncrements` (These are *unsigned*!)
* `integer`
* `bigInteger`
* `text` (Use the optional `TEXT_TYPE` for specifying a specific type. Default is `text`)
* `tinytext`, `mediumtext`, `longtext`
* `char`
* `string`, `varchar` (Is a `VARCHAR`, and defaults to 255 in length)
* `float`
* `double`
* `decimal`
* `boolean`
* `date`
* `dateTime`
* `time`
* `timestamp` / `timestamptz`
* `binary`
* `enum` (Use with `enum_values`)
* `json` / `jsonb`
* `uuid`
* `:<OTHER_TYPE>` will use a db-specific type that is not in the predefined list above

#### *LENGTH*:
Specifies the length of a `string` column. Defaults to 255.

#### *TEXT_TYPE*:
Specifies a specific native text type for the `text` column. Defaults to "text".

#### *PRECISION*:
Precision means how many digits can this number hold.
i.e a precision of 5 will be able to hold "12345" or "123.45" or "0.1234"

#### *SCALE*:
Scale means how many digits (out of the precision) will be used for decimal point
i.e a precision of 5 and a scale of 2 will be able to hold "123.45" or "123.4", but not "123.456" and not "12.345"

#### *MYSQL_ENGINE_TYPE*:
* Only applicable to MySql databases
* `InnoDB`
* `MyISAM`
* `Memory`
* `Merge`
* `Archive`
* `Federated`
* `NDB`


## Contributing

If you have anything to contribute, or functionality that you luck - you are more than welcome to participate in this!
If anyone wishes to contribute unit tests - that also would be great :-)

## Me
* Hi! I am Daniel Cohen Gindi. Or in short- Daniel.
* danielgindi@gmail.com is my email address.
* That's all you need to know.

## License

All the code here is under MIT license. Which means you could do virtually anything with the code.
I will appreciate it very much if you keep an attribution where appropriate.

    The MIT License (MIT)

    Copyright (c) 2013 Daniel Cohen Gindi (danielgindi@gmail.com)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
