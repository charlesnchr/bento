package com.charles.bento.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * A SQLite database in WAL mode with a `kv` table, the layout the Mac's stores use. Stores
 * keep every document in memory and write through (they're small), on the engine thread.
 */
class Db(context: Context, name: String, private val schema: List<String>, private val migrations: (SQLiteDatabase) -> Unit = {}) :
    SQLiteOpenHelper(context, name, null, 1) {

    init {
        setWriteAheadLoggingEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        schema.forEach(db::execSQL)
        db.execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }

    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        if (!db.isReadOnly) {
            schema.forEach(db::execSQL) // CREATE … IF NOT EXISTS: cheap, and covers tables added later
            db.execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            migrations(db)
        }
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    val db: SQLiteDatabase get() = writableDatabase

    fun columns(table: String): Set<String> =
        db.rawQuery("PRAGMA table_info($table)", null).use { c -> buildSet { while (c.moveToNext()) add(c.getString(1)) } }

    fun <T> query(sql: String, vararg args: String, row: (Cursor) -> T): List<T> =
        db.rawQuery(sql, args).use { c -> buildList { while (c.moveToNext()) add(row(c)) } }

    fun kvAll(): MutableMap<String, String> =
        query("SELECT key, value FROM kv") { it.getString(0) to it.getString(1) }.toMap().toMutableMap()

    fun setKV(key: String, value: String?) {
        if (value == null) db.delete("kv", "key = ?", arrayOf(key))
        else db.insertWithOnConflict("kv", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    inline fun transaction(block: () -> Unit) {
        db.beginTransaction()
        try {
            block()
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }
}

fun Cursor.str(name: String): String? = getColumnIndex(name).takeIf { it >= 0 && !isNull(it) }?.let(::getString)
fun Cursor.long(name: String): Long? = getColumnIndex(name).takeIf { it >= 0 && !isNull(it) }?.let(::getLong)
