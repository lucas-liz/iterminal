package com.ruoyi.iterminal.service;

import java.sql.PreparedStatement;
import java.sql.Statement;
import org.springframework.jdbc.core.ArgumentPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;

/**
 * JdbcTemplate 小工具。
 * 不在事务里时，JdbcTemplate 每次调用都可能从连接池拿到不同的连接，
 * 所以 insert 之后再查 last_insert_id() 可能拿到别的连接上的 ID；这里用同一条语句的生成主键。
 */
final class ItmJdbc
{
    private ItmJdbc()
    {
    }

    static Long insert(JdbcTemplate jdbc, String sql, Object... args)
    {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS);
            new ArgumentPreparedStatementSetter(args).setValues(ps);
            return ps;
        }, keys);
        Number key = keys.getKey();
        return key == null ? null : key.longValue();
    }
}
