//! SQLite INTEGER is signed; application revisions and cursors are unsigned.
//! Never wrap a large owner-supplied value or reinterpret a corrupt negative row.
use crate::model::{Error, Result};
use rusqlite::Row;
use serde_json::Value;

pub(crate) fn to_sql_u64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::new("SQL_INTEGER_RANGE", "Значение превышает диапазон целого SQLite"))
}

pub(crate) fn from_sql_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

pub(crate) fn required_sql_u64(value: &Value, key: &str) -> Result<i64> {
    let number = value[key].as_u64().ok_or_else(|| Error::new("SQL_INTEGER_RANGE", format!("Нет неотрицательного целого {key}")))?;
    to_sql_u64(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_boundary_roundtrips_without_wrap() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        for value in [0, 1, i64::MAX as u64] {
            let actual = db.query_row("SELECT ?1", [to_sql_u64(value).unwrap()], |row| from_sql_u64(row, 0)).unwrap();
            assert_eq!(actual, value);
        }
        assert!(to_sql_u64(i64::MAX as u64 + 1).is_err());
        assert!(to_sql_u64(u64::MAX).is_err());
        assert!(db.query_row("SELECT -1", [], |row| from_sql_u64(row, 0)).is_err());
    }
}
