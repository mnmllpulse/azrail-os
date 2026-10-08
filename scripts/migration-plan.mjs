export const workbenchMigrations = ['010-workbench-artifacts.sql','011-project-workbench.sql','012-project-plugins.sql','013-project-models.sql'];
/** Column inspection happens against the database, never an assumed version. */
export function workbenchMigrationPlan(read, columns) {
  const sql=[];
  for(const [table,column,type] of [['studio_artifacts','project_id','TEXT'],['connector_calls','project_id','TEXT'],['connector_calls','plugin_revision','INTEGER']]) {
    if(!columns(table).has(column))sql.push(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
  for(const file of workbenchMigrations)sql.push(read(file).split('\n').filter(line=>!line.startsWith('ALTER TABLE ')).join('\n'));
  return sql.join('\n\n');
}
