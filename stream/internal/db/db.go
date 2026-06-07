package db

import (
	"database/sql"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

type StreamFile struct {
	JobID     string
	Filename  string
	FileID    string
	FileSize  int64
	ChatID    int64
	MessageID int
}

type DB struct {
	db *sql.DB
	mu sync.RWMutex
}

func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite3", path+"?mode=ro&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	return &DB{db: sqlDB}, nil
}

func (d *DB) GetStreamFile(jobID, filename string) (*StreamFile, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	row := d.db.QueryRow(
		"SELECT job_id, filename, file_id, file_size, chat_id, message_id FROM stream_files WHERE job_id = ? AND filename = ?",
		jobID, filename,
	)

	var f StreamFile
	err := row.Scan(&f.JobID, &f.Filename, &f.FileID, &f.FileSize, &f.ChatID, &f.MessageID)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (d *DB) GetStreamFiles(jobID string) ([]StreamFile, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	rows, err := d.db.Query(
		"SELECT job_id, filename, file_id, file_size, chat_id, message_id FROM stream_files WHERE job_id = ?",
		jobID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []StreamFile
	for rows.Next() {
		var f StreamFile
		if err := rows.Scan(&f.JobID, &f.Filename, &f.FileID, &f.FileSize, &f.ChatID, &f.MessageID); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}
