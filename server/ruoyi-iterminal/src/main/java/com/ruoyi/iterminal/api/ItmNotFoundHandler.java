package com.ruoyi.iterminal.api;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import com.ruoyi.common.core.domain.AjaxResult;

/**
 * 不存在的接口：若依的全局异常处理会返回 HTTP 200 + {code: 500, msg: "No static resource …"}，客户端会当成成功。
 * 客户端接口（/api/v1/**）返回 HTTP 404 + {code: 404, message}；管理后台接口返回 {code: 404, msg}，提示可能是服务端版本旧了。
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice
public class ItmNotFoundHandler
{
    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<?> notFound(NoResourceFoundException e, HttpServletRequest req)
    {
        String path = req.getRequestURI();
        String msg = "接口不存在：" + path + "（服务端可能还是旧版本，请升级）";
        if (path.contains("/api/v1/"))
        {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResult.error(404, msg));
        }
        return ResponseEntity.ok(AjaxResult.error(404, msg));
    }
}
